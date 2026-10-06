// microCMS の customers スキーマ（サインアップ/認証/課金用）への読み書き。
// 108teaworks/next-app/lib/microcmsCustomers.ts のREST呼び出しパターンをCommonJSへ移植したもの。
// customers は microCMS無料プランの5スキーマ上限に対応するため固定のトップレベル項目
//（slug/companyName/contactName/status/plan等）を持ち、認証情報（email/passwordHash）は
// users 繰り返しフィールドにネストする設計。slugはコード側で自動生成し、
// json/client_tokens.json のキーとして流用する。
const crypto = require("crypto");
const { microcmsFetch } = require("./microcms");

function escFilterValue(v) {
  return encodeURIComponent(v);
}

/** メールアドレスで顧客レコードを検索する（存在しなければnull） */
async function getCustomerByEmail(email) {
  const res = await microcmsFetch(
    `/customers?filters=email[equals]${escFilterValue(email.trim())}&limit=1`
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[customerStore] getCustomerByEmail failed ${res.status} ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const contents = Array.isArray(json.contents) ? json.contents : [];
  return contents[0] || null;
}

async function customerExistsByEmail(email) {
  const customer = await getCustomerByEmail(email);
  return Boolean(customer);
}

async function getCustomerById(id) {
  const res = await microcmsFetch(`/customers/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[customerStore] getCustomerById failed ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

/** StripeカスタマーIDで顧客レコードを検索する（invoice.payment_failedウェブフック用。
 *  イベントにはStripeカスタマーIDしか含まれず、内部customerIdは含まれないため必要）。 */
async function getCustomerByStripeCustomerId(stripeCustomerId) {
  const res = await microcmsFetch(
    `/customers?filters=stripeCustomerId[equals]${escFilterValue(stripeCustomerId)}&limit=1`
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[customerStore] getCustomerByStripeCustomerId failed ${res.status} ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const contents = Array.isArray(json.contents) ? json.contents : [];
  return contents[0] || null;
}

async function getCustomerByVerificationToken(token) {
  const res = await microcmsFetch(
    `/customers?filters=verificationToken[equals]${escFilterValue(token)}&limit=1`
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[customerStore] getCustomerByVerificationToken failed ${res.status} ${text.slice(0, 300)}`
    );
  }
  const json = await res.json();
  const contents = Array.isArray(json.contents) ? json.contents : [];
  return contents[0] || null;
}

// plan は内部的に basic/standard/advanced（小文字）で扱うが、
// customers.plan の選択肢定義は先頭大文字（Basic/Standard/Advanced）。
function toPlanChoice(plan) {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/**
 * 新規顧客レコードを作成する。
 * passwordHash 等の認証情報は users 繰り返しフィールドにネストする
 *（customers トップレベルには存在しないため）。
 * status/plan はセレクト項目のため配列形式で送信する。
 * @returns 作成されたレコード（idを含む）
 */
async function createCustomer({
  email,
  passwordHash,
  plan,
  contactName,
  companyName,
  verificationToken,
  verifyExpiresAt,
  trialEndsAt,
}) {
  const res = await microcmsFetch(`/customers`, {
    method: "POST",
    body: JSON.stringify({
      slug: crypto.randomUUID(),
      email: email.trim(),
      contactName: contactName.trim(),
      companyName: (companyName || "").trim(),
      status: ["trial"],
      plan: [toPlanChoice(plan)],
      verificationToken,
      verifyExpiresAt,
      trialEndsAt,
      users: [
        {
          fieldId: "users",
          userId: crypto.randomUUID(),
          email: email.trim(),
          passwordHash: passwordHash,
          // サインアップした本人は自アカウントの管理者（他メンバーを招待できる）
          role: ["管理者"],
        },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[customerStore] createCustomer failed ${res.status} ${text.slice(0, 300)}`);
  }
  const created = await res.json();
  return getCustomerById(created.id);
}

/**
 * customersスキーマに未定義のフィールドをpatchに含めるとmicroCMSが400を返し、
 * status/stripeSubscriptionId等の他の重要な変更も道連れで失敗する
 * （2026-08-25、trialLimitAutoActivatedAtフィールドのスキーマ追加漏れにより、
 * トライアル顧客のstatus更新が繰り返し失敗し、Stripeでのサブスクリプション
 * 二重作成・二重課金を引き起こした実例あり）。該当フィールドを除いて
 * 再試行することで、スキーマ追加漏れが起きても重要な更新だけは通す。
 */
async function updateCustomer(id, patch) {
  const res = await microcmsFetch(`/customers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (res.ok) return true;

  const text = await res.text().catch(() => "");
  const unexpectedKeyMatch = text.match(/'([^']+)' is unexpected key/);
  if (res.status === 400 && unexpectedKeyMatch && unexpectedKeyMatch[1] in patch) {
    const key = unexpectedKeyMatch[1];
    console.warn(
      `[customerStore] updateCustomer: microCMSのcustomersスキーマに"${key}"が未定義のため除外して再試行します。スキーマへのフィールド追加を確認してください。`
    );
    const rest = { ...patch };
    delete rest[key];
    return updateCustomer(id, rest);
  }

  throw new Error(`[customerStore] updateCustomer failed ${res.status} ${text.slice(0, 300)}`);
}

/** メール認証を完了させ、使用済みトークンを消す（trialEndsAtはサインアップ時点で確定済み） */
async function markVerified(id) {
  return updateCustomer(id, {
    isVerified: true,
    verificationToken: "",
    verifyExpiresAt: "",
  });
}

/**
 * customers全件を取得する（ページング）。
 * users繰り返しフィールドの中身はmicroCMSのfiltersで検索できないため、
 * メールアドレス/招待トークンでの検索はここから取得した全件をJS側で走査する。
 * 件数が増えたら見直しが必要な暫定実装。
 */
async function listAllCustomers() {
  const all = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    const res = await microcmsFetch(`/customers?limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[customerStore] listAllCustomers failed ${res.status} ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const contents = Array.isArray(json.contents) ? json.contents : [];
    all.push(...contents);
    if (contents.length < limit) break;
    offset += limit;
  }
  return all;
}

/**
 * 管理者ダッシュボード「利用者一覧」用。メールアドレス（部分一致）・status（完全一致、
 * ただしセレクト項目のため[contains]を使う）で絞り込み、新規登録が新しい順
 * （microCMSの`createdAt`降順）でページングして返す。
 */
async function listCustomersFiltered({ email, status, limit = 50, offset = 0 }) {
  const filterParts = [];
  if (email) filterParts.push(`email[contains]${email.trim()}`);
  if (status) filterParts.push(`status[contains]${status}`);
  const filtersQuery = filterParts.length ? `&filters=${encodeURIComponent(filterParts.join("[and]"))}` : "";
  const res = await microcmsFetch(`/customers?orders=-createdAt&limit=${limit}&offset=${offset}${filtersQuery}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[customerStore] listCustomersFiltered failed ${res.status} ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  return { contents: Array.isArray(json.contents) ? json.contents : [], totalCount: json.totalCount || 0 };
}

/** メールアドレスに一致する users 要素を持つ顧客を探す（本人・招待メンバー問わず） */
async function findCustomerAndUserByEmail(email) {
  const target = email.trim().toLowerCase();
  const customers = await listAllCustomers();
  for (const customer of customers) {
    const user = (customer.users || []).find((u) => (u.email || "").toLowerCase() === target);
    if (user) return { customer, user };
  }
  return null;
}

/** 招待トークンに一致する users 要素を持つ顧客を探す */
async function findCustomerAndUserByInvitationToken(token) {
  const customers = await listAllCustomers();
  for (const customer of customers) {
    const user = (customer.users || []).find((u) => u.invitationToken === token);
    if (user) return { customer, user };
  }
  return null;
}

// role/invitationStatusはmicroCMSのselectフィールド（配列で書き込まれる）のため、
// 読み出し側は常にこのヘルパーで先頭要素を取り出す（team.js等、複数箇所で共有する）。
function roleOf(user) {
  return Array.isArray(user.role) ? user.role[0] : user.role;
}
function invitationStatusOf(user) {
  const status = Array.isArray(user.invitationStatus) ? user.invitationStatus[0] : user.invitationStatus;
  // サインアップ時に作られる唯一の初期要素（オーナー・users[0]）は招待フローを
  // 経ていないためinvitationStatusフィールド自体を持たない。実態としては
  // 常に「承諾済み」相当なので、未設定時はデフォルトで「承諾済み」を返す
  // （2026-08-27: 管理者を承認者候補に含める際、この未設定判定が原因で
  // オーナーだけが候補から漏れていた不具合の修正）。
  return status || "承諾済み";
}

/**
 * 管理者が新しいメンバーを招待する。userId/passwordHash未設定のまま
 * users配列に要素を追加し、招待承諾（acceptInvitation）を待つ状態にする。
 * name: 招待時に管理者が入力する氏名。approverIds: role="編集者"の場合のみ、
 * このユーザーの投稿を承認する既存メンバーのuserId配列（JSON文字列で保持）。
 */
async function addInvitedUser(
  customerId,
  { email, name, role, approverIds, invitedByUserId, invitationToken, invitationExpiresAt }
) {
  const customer = await getCustomerById(customerId);
  if (!customer) {
    throw new Error(`[customerStore] addInvitedUser: customer not found id=${customerId}`);
  }
  const users = Array.isArray(customer.users) ? customer.users : [];
  const invitedUser = {
    fieldId: "users",
    email: email.trim(),
    name: name || "",
    role: [role],
    approverIds: role === "編集者" ? JSON.stringify(approverIds || []) : "",
    invitedBy: invitedByUserId,
    invitationToken,
    invitationExpiresAt,
    invitationStatus: ["招待中"],
  };
  await updateCustomer(customerId, { users: [...users, invitedUser] });
  return invitedUser;
}

/**
 * 既存のpending中招待（同一users要素）をトークン再発行して上書きする（再招待・実質再送）。
 * 配列に重複要素を追加しないよう、既存要素をそのまま更新する。
 */
async function reissueInvitation(customerId, email, { name, role, approverIds, invitedByUserId, invitationToken, invitationExpiresAt }) {
  const customer = await getCustomerById(customerId);
  if (!customer) {
    throw new Error(`[customerStore] reissueInvitation: customer not found id=${customerId}`);
  }
  const target = email.trim().toLowerCase();
  const users = Array.isArray(customer.users) ? customer.users : [];
  const index = users.findIndex((u) => (u.email || "").toLowerCase() === target);
  if (index === -1) {
    throw new Error(`[customerStore] reissueInvitation: user not found email=${email}`);
  }
  const updatedUser = {
    ...users[index],
    name: name || "",
    role: [role],
    approverIds: role === "編集者" ? JSON.stringify(approverIds || []) : "",
    invitedBy: invitedByUserId,
    invitationToken,
    invitationExpiresAt,
    invitationStatus: ["招待中"],
  };
  const newUsers = [...users];
  newUsers[index] = updatedUser;
  await updateCustomer(customerId, { users: newUsers });
  return updatedUser;
}

/**
 * 招待メールのリンクからパスワードを設定し、招待を承諾する。
 * 対象のusers要素にuserIdを新規発行してpasswordHashを保存し、
 * invitationStatusを承諾済みに、招待トークンはクリアする。
 */
async function acceptInvitation(customerId, invitationToken, passwordHash) {
  const customer = await getCustomerById(customerId);
  if (!customer) {
    throw new Error(`[customerStore] acceptInvitation: customer not found id=${customerId}`);
  }
  const users = Array.isArray(customer.users) ? customer.users : [];
  const index = users.findIndex((u) => u.invitationToken === invitationToken);
  if (index === -1) return null;

  const updatedUser = {
    ...users[index],
    userId: crypto.randomUUID(),
    passwordHash,
    invitationStatus: ["承諾済み"],
    invitationToken: "",
    invitationExpiresAt: "",
  };
  const newUsers = [...users];
  newUsers[index] = updatedUser;
  await updateCustomer(customerId, { users: newUsers });
  return updatedUser;
}

/**
 * メンバーを削除する。最上位の権利者（アカウント作成者。users配列の先頭要素＝
 * サインアップ時に作られる唯一の初期要素で、以降の招待は必ず配列末尾に追加される
 * ため、先頭＝作成者であることが保証される）は削除できない。
 * users配列から該当要素を取り除くだけで、その場でrequireAuthの
 * 「該当userIdがcustomer.usersに存在しない」チェックに引っかかるようになり、
 * 既存セッション（JWT）も含めて即座にアクセス不能になる（sessionVersion方式と
 * 同じく確実な失効だが、要素自体が無くなるため個別のバージョン加算は不要）。
 * @returns {Promise<{ok: true} | {ok: false, error: "owner_cannot_be_removed" | "member_not_found"}>}
 */
async function removeMember(customerId, email) {
  const customer = await getCustomerById(customerId);
  if (!customer) {
    throw new Error(`[customerStore] removeMember: customer not found id=${customerId}`);
  }
  const users = Array.isArray(customer.users) ? customer.users : [];
  const target = email.trim().toLowerCase();
  const index = users.findIndex((u) => (u.email || "").toLowerCase() === target);
  if (index === -1) return { ok: false, error: "member_not_found" };
  if (index === 0) return { ok: false, error: "owner_cannot_be_removed" };

  const newUsers = users.filter((_, i) => i !== index);
  await updateCustomer(customerId, { users: newUsers });
  return { ok: true };
}

/** パスワード再設定トークンに一致する users 要素を持つ顧客を探す */
async function findCustomerAndUserByResetToken(token) {
  const customers = await listAllCustomers();
  for (const customer of customers) {
    const user = (customer.users || []).find((u) => u.resetPasswordToken === token);
    if (user) return { customer, user };
  }
  return null;
}

/**
 * パスワード再設定トークンを発行する。同一ユーザーに対する既存トークンは
 * このフィールドを上書きするだけで自動的に無効化される（トークンは常に1件のみ保持）。
 */
async function setPasswordResetToken(customerId, userId, resetToken, resetExpiresAt) {
  const customer = await getCustomerById(customerId);
  if (!customer) {
    throw new Error(`[customerStore] setPasswordResetToken: customer not found id=${customerId}`);
  }
  const users = Array.isArray(customer.users) ? customer.users : [];
  const index = users.findIndex((u) => u.userId === userId);
  if (index === -1) {
    throw new Error(`[customerStore] setPasswordResetToken: user not found userId=${userId}`);
  }
  const newUsers = [...users];
  newUsers[index] = { ...users[index], resetPasswordToken: resetToken, resetPasswordExpAt: resetExpiresAt };
  await updateCustomer(customerId, { users: newUsers });
}

/**
 * 検証済みのパスワード再設定トークンをもとに新しいパスワードを設定する。
 * 使用済みトークンはクリアして再利用を防ぎ、sessionVersionをインクリメントして
 * 発行済みの全JWT（他デバイス・他ブラウザのログインセッションを含む）を無効化する。
 */
async function resetPassword(customerId, resetToken, passwordHash) {
  const customer = await getCustomerById(customerId);
  if (!customer) {
    throw new Error(`[customerStore] resetPassword: customer not found id=${customerId}`);
  }
  const users = Array.isArray(customer.users) ? customer.users : [];
  const index = users.findIndex((u) => u.resetPasswordToken === resetToken);
  if (index === -1) return null;

  const updatedUser = {
    ...users[index],
    passwordHash,
    resetPasswordToken: "",
    resetPasswordExpAt: "",
    sessionVersion: (Number(users[index].sessionVersion) || 0) + 1,
  };
  const newUsers = [...users];
  newUsers[index] = updatedUser;
  await updateCustomer(customerId, { users: newUsers });
  return updatedUser;
}

/**
 * 管理者ダッシュボードの「パスワード初期化」用。トークンを経由せず、メールアドレスで
 * 特定したユーザーのpasswordHashを直接差し替える。resetPassword（トークン検証済み）
 * と同じく、sessionVersionをインクリメントして発行済みの全JWTを無効化する。
 * @returns {customer, user}（更新後のuser）。該当ユーザーが見つからなければnull
 */
async function adminSetPassword(email, passwordHash) {
  const found = await findCustomerAndUserByEmail(email);
  if (!found) return null;
  const { customer, user } = found;
  const users = Array.isArray(customer.users) ? customer.users : [];
  const index = users.findIndex((u) => u.userId === user.userId);
  if (index === -1) return null;

  const updatedUser = {
    ...users[index],
    passwordHash,
    sessionVersion: (Number(users[index].sessionVersion) || 0) + 1,
  };
  const newUsers = [...users];
  newUsers[index] = updatedUser;
  await updateCustomer(customer.id, { users: newUsers });
  return { customer, user: updatedUser };
}

/**
 * 解約済み（status: canceled）の既存customerレコードを、同一メールでの
 * 再サインアップ時に新規レコードを作らず再アクティブ化する。
 * 招待メンバー等の古いusersは破棄し、本人のみの新しいusers配列に置き換える
 * （createCustomerの初期状態と揃える）。stripeCustomerIdは同一Stripe顧客を
 * 使い回すためあえて上書きしない。stripeSubscriptionIdは解約済みの古い
 * サブスクリプションを参照したままにならないようクリアする。
 *
 * トライアルは付与しない（statusは"trial"にしない。2026-08-22修正：それまでは
 * ここでstatus:"trial"・新しいtrialEndsAtを設定しており、「解約→同一メールで
 * 再サインアップした際に無料トライアルを再取得できてしまう抜け穴を塞ぐ」という
 * 導入時のコミットメッセージの意図に反して、実際には抜け穴をそのまま再現していた）。
 * customers.statusのselect選択肢はtrial/active/canceledの3つしか定義されていない
 * ため、代わりに既存の"active"を流用し、trialEndsAtは空にする。決済登録
 * （stripeSubscriptionId）が完了するまでの間の実際のアクセス制限は
 * requiresPaymentRegistration()（旧isTrialExpiredWithoutPayment）が担う。
 * 呼び出し元（routes/auth.js）から渡されるtrialEndsAtパラメータは
 * 意図的に無視する。
 * @returns 更新後のレコード（idを含む）
 */
async function reactivateCustomer(id, {
  email,
  passwordHash,
  plan,
  contactName,
  companyName,
  verificationToken,
  verifyExpiresAt,
}) {
  await updateCustomer(id, {
    email: email.trim(),
    contactName: contactName.trim(),
    companyName: (companyName || "").trim(),
    status: ["active"],
    plan: [toPlanChoice(plan)],
    isVerified: false,
    verificationToken,
    verifyExpiresAt,
    trialEndsAt: "",
    trialPostCount: 0,
    trialReminderSent: false,
    trialReminder5DaySent: false,
    trialReminder2DaySent: false,
    trialLimitAutoActivatedAt: "",
    stripeSubscriptionId: "",
    users: [
      {
        fieldId: "users",
        userId: crypto.randomUUID(),
        email: email.trim(),
        passwordHash,
        role: ["管理者"],
      },
    ],
  });
  return getCustomerById(id);
}

/**
 * ログイン中の本人によるパスワード変更（トークンを介さない）。
 * resetPasswordと同様にsessionVersionをインクリメントして他デバイス・他ブラウザの
 * 既存セッションを無効化する。呼び出し側（ルートハンドラ）で、変更を行った
 * このリクエスト自身のセッションだけは新しいsessionVersionで再発行すること。
 */
async function changePassword(customerId, userId, passwordHash) {
  const customer = await getCustomerById(customerId);
  if (!customer) {
    throw new Error(`[customerStore] changePassword: customer not found id=${customerId}`);
  }
  const users = Array.isArray(customer.users) ? customer.users : [];
  const index = users.findIndex((u) => u.userId === userId);
  if (index === -1) {
    throw new Error(`[customerStore] changePassword: user not found userId=${userId}`);
  }
  const updatedUser = {
    ...users[index],
    passwordHash,
    sessionVersion: (Number(users[index].sessionVersion) || 0) + 1,
  };
  const newUsers = [...users];
  newUsers[index] = updatedUser;
  await updateCustomer(customerId, { users: newUsers });
  return updatedUser;
}

// トライアル終了後・または解約後の再登録直後で、支払い情報未登録のまま利用を
// 続けようとしていないかの判定。SNS連携開始前のガード（requireAuth.js の
// blockExpiredTrial）・投稿系エンドポイントで使用する。
//
// 2026-08-22まではisTrialExpiredWithoutPaymentという名前で「status===trial かつ
// trialEndsAt経過」のみを判定していたが、解約→同一メールでの再登録
// （reactivateCustomer）でトライアルを再付与しない設計に変更したことに伴い対象を
// 拡張した（仕様書作成時のレビューで、reactivateCustomerが実際にはトライアルを
// 再付与してしまっており「無料トライアル再取得の抜け穴を防ぐ」という導入時の
// コミットメッセージの意図に反していたことが発覚したため）：
// - トライアル中（status:"trial"）: 従来通りtrialEndsAtを経過するまでは猶予する
// - トライアル以外（reactivateCustomer後のstatus:"active"）: customers.statusの
//   select選択肢がtrial/active/canceledの3つしか定義されておらず「トライアルなし・
//   未払い」専用の値を追加できないため、既存の"active"を流用している。この場合は
//   猶予期間を設けず、stripeSubscriptionId未登録なら常に支払い必須と判定する
//   （正規のStripe決済完了時は必ずstripeSubscriptionIdと同時にstatus:"active"が
//   セットされるため、実際に課金済みの顧客が誤ってブロックされることはない）
// - 解約済み（status:"canceled"）は対象外（blockCanceledCustomer側の専用ガードに委ねる）
//
// customer.trialEndsAtは「表向き」の日数より3日長い内部バッファ込みの値
// （routes/auth.js の TRIAL_INTERNAL_BUFFER_DAYS 参照）。ここでは意図的にそのまま使う。
function requiresPaymentRegistration(customer) {
  if (customer.stripeSubscriptionId) return false;
  const status = Array.isArray(customer.status) ? customer.status[0] : customer.status;
  if (status === "canceled") return false;
  if (status !== "trial") return true;
  if (!customer.trialEndsAt) return false;
  return new Date(customer.trialEndsAt).getTime() < Date.now();
}

// トライアル中の投稿数上限（全SNS合計）。即時投稿（routes/posts.js）・予約投稿の
// 両方でrequireUnderTrialPostLimitと組み合わせて使う。
const TRIAL_POST_LIMIT = 60;

function getTrialPostCount(customer) {
  const value = Number(customer.trialPostCount);
  return Number.isFinite(value) ? value : 0;
}

// requireAuth.js の requireUnderTrialPostLimit と、cron（スケジュール投稿の実行）の
// 両方から使う純粋関数。req/resに依存しないよう判定ロジックをここに切り出している。
function isTrialPostLimitReached(customer) {
  const status = Array.isArray(customer.status) ? customer.status[0] : customer.status;
  return status === "trial" && getTrialPostCount(customer) >= TRIAL_POST_LIMIT;
}

// トライアル投稿上限の80%到達時に即時メール送信するための閾値（2026-08-25追加）。
// Math.ceilで切り上げ（60*0.8=48ちょうどだが、上限値が将来変わっても整数になるように）。
const TRIAL_POST_LIMIT_WARNING_RATIO = 0.8;
const TRIAL_POST_LIMIT_WARNING_COUNT = Math.ceil(TRIAL_POST_LIMIT * TRIAL_POST_LIMIT_WARNING_RATIO);

// bumpTrialPostCount呼び出し前後のtrialPostCountから、今回の加算で警告ライン
// （80%）を「初めて」跨いだかどうかを判定する純粋関数。trialPostCountは同一トライアル
// 期間中は増加し続ける一方（減ることはない）ため、この判定だけで「1トライアル期間中に
// 一度だけ」を保証でき、専用の送信済みフラグを別途永続化する必要がない
// （新規トライアル開始時はtrialPostCountが0にリセットされるため、次のトライアルでも
// 正しく再度跨ぎ判定される）。呼び出し元（posts.js・scheduledPostExecutor.js）が
// bumpTrialPostCountの前後でこれを呼び、trueならtrialPostLimitWarningMailer.jsで
// 即時メール送信する。
function crossedTrialPostLimitWarning(customer, beforeCount, afterCount) {
  const status = Array.isArray(customer.status) ? customer.status[0] : customer.status;
  if (status !== "trial") return false;
  return beforeCount < TRIAL_POST_LIMIT_WARNING_COUNT && afterCount >= TRIAL_POST_LIMIT_WARNING_COUNT;
}

// crossedTrialPostLimitWarningと同じ考え方で、今回の加算で上限（60通）ラインを
// 「初めて」跨いだかどうかを判定する純粋関数（2026-08-25追加）。trueの場合、
// trialLimitAutoActivation.jsで「支払い方法登録済みなら即時本稼働へ切り替え・
// 未登録ならそのままブロック」を判定する（呼び出し元はcrossedTrialPostLimitWarning
// と同じ3箇所: posts.js×2・scheduledPostExecutor.js）。
function crossedTrialPostLimit(customer, beforeCount, afterCount) {
  const status = Array.isArray(customer.status) ? customer.status[0] : customer.status;
  if (status !== "trial") return false;
  return beforeCount < TRIAL_POST_LIMIT && afterCount >= TRIAL_POST_LIMIT;
}

// requireAuth.js の blockCanceledCustomer と、cron（スケジュール投稿の実行）の
// 両方から使う純粋関数。
function isCanceled(customer) {
  const status = Array.isArray(customer.status) ? customer.status[0] : customer.status;
  return status === "canceled";
}

// 解約から同一メールアドレスでの再登録を24時間ロックする（signup.js参照。
// 2026-09-02追加。解約と同時にStripeへ最終請求書の決済を試みるが、失敗時の
// Stripe側リトライ等に猶予を持たせるため、カード情報の削除も解約直後ではなく
// 解約から23:30後に遅延させる＝それまでは解約済みでもカードが残っている。この間に
// 即座に同一メールで再登録できてしまうと、古いStripe Customer/カードを引き継いだ
// 状態で新しいトライアル相当の利用ができてしまうため、24時間はロックする）。
const RECENT_CANCELLATION_LOCK_MS = 24 * 60 * 60 * 1000;
// カード情報の削除を解約から遅延させる猶予（23:30 = 23時間30分）。Stripeへの
// 最終請求書決済（account.js）が完了するのに十分な時間を確保しつつ、24時間の
// 再登録ロックが解ける直前にはカードが無くなっている状態にするための値。
const CARD_DELETION_DELAY_MS = (23 * 60 + 30) * 60 * 1000;

// customer.canceledAtがmicroCMSスキーマ未対応で書き込めていない場合は、
// 常にfalse（＝制限しない／削除しない）を返す安全側フォールバックとする。
// 2026-08-25に発生した「未定義フィールドのため判定が常に一方向に倒れて
// 重複課金を招いた」事故（trialLimitAutoActivatedAt、CLAUDE.md参照）の教訓を踏まえ、
// この機能は「フィールドが無ければ何もしない」側に倒す（誤ってロック/削除し
// 続けるより、機能が無効なままの方が安全）。
function isWithinCancellationLock(customer) {
  if (!customer.canceledAt) return false;
  return Date.now() - new Date(customer.canceledAt).getTime() < RECENT_CANCELLATION_LOCK_MS;
}

// scripts/canceledCardCleanup.js（cron）から使う。解約後23:30を過ぎた
// カード削除待ちの顧客を判定する純粋関数。
function isPastCardDeletionDelay(customer) {
  if (!customer.canceledAt) return false;
  return Date.now() - new Date(customer.canceledAt).getTime() >= CARD_DELETION_DELAY_MS;
}

// customers.trialPostCount フィールドをdelta件分だけ加算する。
// ループ内で複数回呼ぶと「req.customerの値が更新されないまま同じ古い値+1を
// 複数回書き込んでしまう」バグになるため、呼び出し側は成功件数を集計してから
// 一度だけ呼ぶこと（delta<=0の場合は何もしない）。
async function bumpTrialPostCount(customerId, currentCustomer, delta) {
  if (delta <= 0) return getTrialPostCount(currentCustomer);
  const next = getTrialPostCount(currentCustomer) + delta;
  await updateCustomer(customerId, { trialPostCount: next });
  return next;
}

// customers.trialEndsAtは「表向き」の日数より3日長い内部バッファ込みの値
// （routes/auth.jsのTRIAL_INTERNAL_BUFFER_DAYS参照。同じ値をここでも独立して
// 定義している。どちらかを変更する際はもう一方も見直すこと）。
const TRIAL_INTERNAL_BUFFER_DAYS = 3;

/**
 * トライアル終了（表向きの終了日＝trialDisplayEndsAt基準）が指定日数以内に迫っていて、
 * 該当ウィンドウのリマインドがまだ未送信の顧客一覧を取得する。
 * @param {number} displayDaysBeforeEnd 表向きの残り日数がこの日数以下になったら対象（例: 5, 2）
 * @param {string} sentField このウィンドウの送信済みフラグのフィールド名
 *   （例: "trialReminder5DaySent"）
 */
async function listCustomersForTrialReminder(displayDaysBeforeEnd, sentField) {
  // trialDisplayEndsAt = trialEndsAt - TRIAL_INTERNAL_BUFFER_DAYS。
  // 「表向きの残り日数 <= displayDaysBeforeEnd」を、格納されている生のtrialEndsAtに
  // 対するフィルタに変換すると、cutoff = now + (displayDaysBeforeEnd + BUFFER)日 になる。
  const cutoff = new Date(
    Date.now() + (displayDaysBeforeEnd + TRIAL_INTERNAL_BUFFER_DAYS) * 24 * 60 * 60 * 1000
  ).toISOString();
  const filters = [
    "isVerified[equals]true",
    // statusはmicroCMSのセレクトフィールド（配列書き込み）のため[contains]で一致させる
    // （listPendingScheduledPosts等と同じ注意点）。
    "status[contains]trial",
    `${sentField}[equals]false`,
    `trialEndsAt[less_than]${cutoff}`,
  ].join("[and]");
  const res = await microcmsFetch(`/customers?filters=${encodeURIComponent(filters)}&limit=100`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[customerStore] listCustomersForTrialReminder failed ${res.status} ${text.slice(0, 300)}`
    );
  }
  const json = await res.json();
  return Array.isArray(json.contents) ? json.contents : [];
}

/**
 * トライアル中で投稿数上限（60通）に既に達している顧客一覧を取得する
 * （trialPostLimitAutoActivationSync.js専用）。
 *
 * 60通到達時の自動アクティベート（trialLimitAutoActivation.js）は、posts.js・
 * scheduledPostExecutor.js・scheduleMaterializer.js・requireUnderTrialPostLimit
 * ミドルウェアの計4箇所いずれかが実際に動くタイミングでしか発火しないリアクティブな
 * 仕組みのみだった。継続スケジュール投稿しか使っていない顧客が「その日の分は
 * scheduleMaterializer.jsで既に生成済み（last_materialized_dt一致でスキップ）」
 * かつ「実行待ちのscheduled_postsが0件（実行トリガーも無い）」という状態に
 * 一度でも入ると、支払い方法を登録済みでも次にその顧客の予約が新規生成される
 * タイミング（早くて翌日）までアクティベートされないまま放置される
 * （実機で確認: shin.takase@icloud.com、2026-08-25）。この関数はその穴を埋める
 * 日次cron向けに、上記4箇所とは独立して「トライアル中かつ投稿数60通以上」の
 * 全顧客を横断的に取得する。
 */
async function listCustomersOverTrialPostLimit() {
  const filters = [
    // statusはmicroCMSのセレクトフィールド（配列書き込み）のため[contains]で一致させる
    // （listCustomersForTrialReminderと同じ注意点）。
    "status[contains]trial",
    `trialPostCount[greater_than]${TRIAL_POST_LIMIT - 1}`,
  ].join("[and]");
  const res = await microcmsFetch(`/customers?filters=${encodeURIComponent(filters)}&limit=100`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[customerStore] listCustomersOverTrialPostLimit failed ${res.status} ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  return Array.isArray(json.contents) ? json.contents : [];
}

module.exports = {
  getCustomerByEmail,
  customerExistsByEmail,
  getCustomerById,
  getCustomerByStripeCustomerId,
  getCustomerByVerificationToken,
  createCustomer,
  reactivateCustomer,
  updateCustomer,
  toPlanChoice,
  markVerified,
  changePassword,
  requiresPaymentRegistration,
  TRIAL_POST_LIMIT,
  TRIAL_POST_LIMIT_WARNING_RATIO,
  TRIAL_POST_LIMIT_WARNING_COUNT,
  getTrialPostCount,
  isTrialPostLimitReached,
  crossedTrialPostLimitWarning,
  crossedTrialPostLimit,
  isCanceled,
  isWithinCancellationLock,
  isPastCardDeletionDelay,
  bumpTrialPostCount,
  listCustomersForTrialReminder,
  listCustomersOverTrialPostLimit,
  listAllCustomers,
  listCustomersFiltered,
  findCustomerAndUserByEmail,
  findCustomerAndUserByInvitationToken,
  findCustomerAndUserByResetToken,
  setPasswordResetToken,
  resetPassword,
  adminSetPassword,
  roleOf,
  invitationStatusOf,
  addInvitedUser,
  reissueInvitation,
  acceptInvitation,
  removeMember,
};

module.exports = require("../data/storeSelector").selectStore("customerStore", module.exports);
