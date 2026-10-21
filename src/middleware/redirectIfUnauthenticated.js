// ブラウザ遷移で開かれるOAuth開始URL用。未ログイン（セッションCookieなし/JWT無効）なら
// 401 JSONではなくログイン画面へ送り、ログイン後に元のURLへ戻れるよう returnTo を付ける。
// APIのrequireAuthは変更しない。ログイン済みの場合は何もせず、続くrequireAuthが顧客を検証する。
const { verifySession } = require("../lib/jwt");
const { readSessionToken } = require("./requireAuth");
const { isSafeReturnTo } = require("../lib/returnTo");

function redirectIfUnauthenticated(req, res, next) {
  const token = readSessionToken(req);
  if (token && verifySession(token)) return next();
  const target = isSafeReturnTo(req.originalUrl) ? `?returnTo=${encodeURIComponent(req.originalUrl)}` : "";
  return res.redirect(`/login.html${target}`);
}

module.exports = { redirectIfUnauthenticated };
