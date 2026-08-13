// サインインセッション用のJWT発行・検証。express-session等は使わず、
// httpOnly Cookieにトークンをそのまま入れるステートレス方式。
const jwt = require("jsonwebtoken");

const COOKIE_NAME = "sns_poster_session";
const EXPIRES_IN = "30d";

function signSession(customer) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET が未設定です");
  return jwt.sign({ sub: customer.id, email: customer.email }, secret, {
    expiresIn: EXPIRES_IN,
  });
}

function verifySession(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET が未設定です");
  try {
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

module.exports = { COOKIE_NAME, signSession, verifySession, setSessionCookie, clearSessionCookie };
