// microCMS の customers スキーマ（サインアップ/認証/課金用）への読み書き。
// 108teaworks/next-app/lib/microcmsCustomers.ts のREST呼び出しパターンをCommonJSへ移植したもの。
// customersのmicroCMSレコードidをそのままSNS連携（json/client_tokens.json）のslugとして流用する。

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
    `/customers?filters=${encodeURIComponent(`email[equals]${escFilterValue(email.trim())}`)}&limit=1`
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
    `/customers?filters=${encodeURIComponent(`verification_token[equals]${escFilterValue(token)}`)}&limit=1`
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

/**
 * 新規顧客レコードを作成する。
 * @returns 作成されたレコード（idを含む）
 */
async function createCustomer({ email, passwordHash, plan, verificationToken, verificationTokenExpiresAt }) {
  const res = await microcmsFetch(`/customers`, {
    method: "POST",
    body: JSON.stringify({
      email: email.trim(),
      password_hash: passwordHash,
      plan,
      is_verified: false,
      verification_token: verificationToken,
      verification_token_expires_at: verificationTokenExpiresAt,
      trial_ends_at: "",
      trial_reminder_sent: false,
      stripe_customer_id: "",
      stripe_subscription_status: "",
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

/** メール認証を完了させ、トライアル期限を確定する */
async function markVerified(id, trialEndsAtIso) {
  return updateCustomer(id, {
    is_verified: true,
    verification_token: "",
    verification_token_expires_at: "",
    trial_ends_at: trialEndsAtIso,
  });
}

/**
 * トライアル終了が迫っていてリマインド未送信の顧客一覧を取得する。
 * @param {number} withinDays 残り何日以内を対象にするか
 */
async function listCustomersWithUpcomingTrialEnd(withinDays) {
  const cutoff = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000).toISOString();
  const filters = [
    "is_verified[equals]true",
    "trial_reminder_sent[equals]false",
    `trial_ends_at[less_than]${cutoff}`,
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
  updateCustomer,
  markVerified,
  listCustomersWithUpcomingTrialEnd,
};
