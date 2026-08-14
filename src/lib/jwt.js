// サインインセッション用のJWT発行・検証。express-session等は使わず、
// httpOnly Cookieにトークンをそのまま入れるステートレス方式。
const jwt = require("jsonwebtoken");

const COOKIE_NAME = "sns_poster_session";
const EXPIRES_IN = "30d";

// customers は1アカウントに複数ユーザー（users繰り返しフィールド）を持ちうるため、
// セッションにはアカウント（customer.id）だけでなく、ログイン中の個人（user.userId）も入れる。
// sessionVersion は users[].sessionVersion のスナップショット。パスワード再設定時に
// users[].sessionVersion をインクリメントすることで、発行済みの全JWTを一括失効させる
// （express-session等のサーバー側セッションストアを持たないステートレス方式のため、
// 「全セッション無効化」はこのバージョン比較でしか実現できない）。
function signSession(customer, user) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET が未設定です");
  return jwt.sign(
    { sub: customer.id, userId: user.userId, email: user.email, sessionVersion: user.sessionVersion || 0 },
    secret,
    { expiresIn: EXPIRES_IN }
  );
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
