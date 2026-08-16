// microCMS の customers スキーマ（サインアップ/認証/課金用）への読み書き。
// 108teaworks/next-app/lib/microcmsCustomers.ts のREST呼び出しパターンをCommonJSへ移植したもの。
// customers は microCMS無料プランの5スキーマ上限に対応するため固定のトップレベル項目
//（slug/companyName/contactName/status/plan等）を持ち、認証情報（email/passwordHash）は
// users 繰り返しフィールドにネストする設計。slugはコード側で自動生成し、
// json/client_tokens.json のキーとして流用する。
const crypto = require("crypto");

function getBaseUrl() {
  const domain = process.env.MICROCMS_SERVICE_DOMAIN;
  if (!domain) return null;
  return `https://${domain}.microcms.io/api/v1`;
}

function getApiKey() {
  return process.env.MICROCMS_WRITE_API_KEY || process.env.MICROCMS_API_KEY;
}

function escFilterValue(v) {
  return encodeURIComponent(v);
}

async function microcmsFetch(pathAndQuery, options = {}) {
  const base = getBaseUrl();
  const key = getApiKey();
  if (!base || !key) {
    throw new Error("MICROCMS_SERVICE_DOMAIN または MICROCMS_API_KEY が未設定です");
  }
  const res = await fetch(`${base}${pathAndQuery}`, {
    ...options,
    headers: {
      "X-MICROCMS-API-KEY": key,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  return res;
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

async function updateCustomer(id, patch) {
  const res = await microcmsFetch(`/customers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[customerStore] updateCustomer failed ${res.status} ${text.slice(0, 300)}`);
  }
  return true;
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

/**
 * 管理者が新しいメンバーを招待する。userId/passwordHash未設定のまま
 * users配列に要素を追加し、招待承諾（acceptInvitation）を待つ状態にする。
 */
async function addInvitedUser(customerId, { email, role, invitedByUserId, invitationToken, invitationExpiresAt }) {
  const customer = await getCustomerById(customerId);
  if (!customer) {
    throw new Error(`[customerStore] addInvitedUser: customer not found id=${customerId}`);
  }
  const users = Array.isArray(customer.users) ? customer.users : [];
  const invitedUser = {
    fieldId: "users",
    email: email.trim(),
    role: [role],
    invitedBy: invitedByUserId,
    invitationToken,
    invitationExpiresAt,
    invitationStatus: ["招待中"],
  };
  await updateCustomer(customerId, { users: [...users, invitedUser] });
  return invitedUser;
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
 * 解約済み（status: canceled）の既存customerレコードを、同一メールでの
 * 再サインアップ時に新規レコードを作らず再アクティブ化する。
 * 招待メンバー等の古いusersは破棄し、本人のみの新しいusers配列に置き換える
 * （createCustomerの初期状態と揃える）。stripeCustomerIdは同一Stripe顧客を
 * 使い回すためあえて上書きしない。stripeSubscriptionIdは解約済みの古い
 * サブスクリプションを参照したままにならないようクリアする。
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
  trialEndsAt,
}) {
  await updateCustomer(id, {
    email: email.trim(),
    contactName: contactName.trim(),
    companyName: (companyName || "").trim(),
    status: ["trial"],
    plan: [toPlanChoice(plan)],
    isVerified: false,
    verificationToken,
    verifyExpiresAt,
    trialEndsAt,
    trialPostCount: 0,
    trialReminderSent: false,
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

// トライアル終了後、支払い情報未登録のまま利用を続けようとしていないかの判定。
// SNS連携開始前のガード（requireAuth.js の blockExpiredTrial）で使用する。
function isTrialExpiredWithoutPayment(customer) {
  const status = Array.isArray(customer.status) ? customer.status[0] : customer.status;
  if (status !== "trial") return false;
  if (!customer.trialEndsAt) return false;
  if (new Date(customer.trialEndsAt).getTime() >= Date.now()) return false;
  return !customer.stripeSubscriptionId;
}

// トライアル中の投稿数上限（全SNS合計）。実投稿エンドポイント実装時に、
// 成功した投稿ごとにincrementTrialPostCountを呼び出してカウントする想定。
const TRIAL_POST_LIMIT = 60;

function getTrialPostCount(customer) {
  const value = Number(customer.trialPostCount);
  return Number.isFinite(value) ? value : 0;
}

// customers.trialPostCount フィールド（数値、未作成の場合はmicroCMS管理画面で
// 追加が必要）をインクリメントする。呼び出し側で最新のcustomerを渡すこと。
async function incrementTrialPostCount(customer) {
  const next = getTrialPostCount(customer) + 1;
  await updateCustomer(customer.id, { trialPostCount: next });
  return next;
}

/**
 * トライアル終了が迫っていてリマインド未送信の顧客一覧を取得する。
 * @param {number} withinDays 残り何日以内を対象にするか
 */
async function listCustomersWithUpcomingTrialEnd(withinDays) {
  const cutoff = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000).toISOString();
  const filters = [
    "isVerified[equals]true",
    "trialReminderSent[equals]false",
    `trialEndsAt[less_than]${cutoff}`,
  ].join("[and]");
  const res = await microcmsFetch(`/customers?filters=${encodeURIComponent(filters)}&limit=100`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[customerStore] listCustomersWithUpcomingTrialEnd failed ${res.status} ${text.slice(0, 300)}`
    );
  }
  const json = await res.json();
  return Array.isArray(json.contents) ? json.contents : [];
}

module.exports = {
  getCustomerByEmail,
  customerExistsByEmail,
  getCustomerById,
  getCustomerByVerificationToken,
  createCustomer,
  reactivateCustomer,
  updateCustomer,
  toPlanChoice,
  markVerified,
  changePassword,
  isTrialExpiredWithoutPayment,
  TRIAL_POST_LIMIT,
  getTrialPostCount,
  incrementTrialPostCount,
  listCustomersWithUpcomingTrialEnd,
  listAllCustomers,
  findCustomerAndUserByEmail,
  findCustomerAndUserByInvitationToken,
  findCustomerAndUserByResetToken,
  setPasswordResetToken,
  resetPassword,
  addInvitedUser,
  acceptInvitation,
};
