// Cookie内のJWTを検証し、有効なら req.customer にmicroCMSの顧客レコードをセットする。
// cookie-parser等の追加依存を避け、Cookieヘッダーを直接パースする。
const { COOKIE_NAME, verifySession } = require("../lib/jwt");
const { getCustomerById } = require("../lib/customerStore");

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

module.exports = { requireAuth, requireVerified, readSessionToken, parseCookieHeader };
