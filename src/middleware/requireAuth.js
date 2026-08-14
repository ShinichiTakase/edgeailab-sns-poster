// Cookie内のJWTを検証し、有効なら req.customer にmicroCMSの顧客レコードをセットする。
// cookie-parser等の追加依存を避け、Cookieヘッダーを直接パースする。
const { COOKIE_NAME, verifySession } = require("../lib/jwt");
const {
  getCustomerById,
  isTrialExpiredWithoutPayment,
  getTrialPostCount,
  TRIAL_POST_LIMIT,
} = require("../lib/customerStore");

function parseCookieHeader(header) {
  const result = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

function readSessionToken(req) {
  const cookies = parseCookieHeader(req.headers.cookie);
  return cookies[COOKIE_NAME] || null;
}

async function requireAuth(req, res, next) {
  const token = readSessionToken(req);
  const payload = token && verifySession(token);
  if (!payload) {
    return res.status(401).json({ error: "unauthenticated" });
  }
  try {
    const customer = await getCustomerById(payload.sub);
    if (!customer) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    const user = (customer.users || []).find((u) => u.userId === payload.userId);
    if (!user) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    // パスワード再設定でsessionVersionがインクリメントされていたら、
    // このJWTは旧セッションとして無効（全セッション無効化の実現手段）。
    if ((payload.sessionVersion || 0) !== (user.sessionVersion || 0)) {
      return res.status(401).json({ error: "unauthenticated" });
    }
    req.customer = customer;
    req.user = user;
    next();
  } catch (err) {
    console.error("[requireAuth] failed to load customer:", err);
    res.status(500).json({ error: "internal_error" });
  }
}

// requireAuthの後段に挟んで使う。メール未認証のアカウントで
// SNS実投稿・メンバー招待送信など「実害のある操作」をブロックするためのガード。
// フロント側のボタン非活性化と対で、サーバー側の必須チェックとして機能する。
function requireVerified(req, res, next) {
  if (!req.customer || !req.customer.isVerified) {
    return res.status(403).json({ error: "email_not_verified", message: "メール認証が完了していません" });
  }
  next();
}

// requireAuthの後段に挟んで使う。トライアル終了後、支払い情報未登録のまま
// SNS連携（OAuth認可フロー）を開始しようとした場合にカード登録画面へ誘導する。
function blockExpiredTrial(req, res, next) {
  if (isTrialExpiredWithoutPayment(req.customer)) {
    return res.redirect("/upgrade.html?reason=trial_expired");
  }
  next();
}

// 実投稿エンドポイント実装時に requireAuth・requireVerified と並べて
// 組み込む想定のミドルウェア（設計のみ。現時点ではどのルートにも未接続）。
// トライアル中（status: trial）に限り、全SNS合計の投稿数が
// customerStore.TRIAL_POST_LIMIT（60通）に達した時点で以降の投稿をブロックする。
// customers.trialPostCount フィールドが未作成の場合はmicroCMS管理画面での追加が必要。
function requireUnderTrialPostLimit(req, res, next) {
  const customer = req.customer;
  const status = Array.isArray(customer.status) ? customer.status[0] : customer.status;
  if (status === "trial" && getTrialPostCount(customer) >= TRIAL_POST_LIMIT) {
    return res.status(403).json({
      error: "trial_post_limit_reached",
      message: `トライアル中の投稿上限（${TRIAL_POST_LIMIT}通）に達しました`,
    });
  }
  next();
}

module.exports = {
  requireAuth,
  requireVerified,
  blockExpiredTrial,
  requireUnderTrialPostLimit,
  readSessionToken,
  parseCookieHeader,
};
