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

module.exports = { requireAuth, readSessionToken, parseCookieHeader };
