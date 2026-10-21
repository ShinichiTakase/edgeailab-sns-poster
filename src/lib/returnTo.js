// ログイン後の戻り先(returnTo)の検証。オープンリダイレクト防止のため、
// 「/」始まりの同一オリジンのパスで、かつOAuth開始URLの許可リストに一致するものだけを通す。
// login.html（静的サイト側）にも同じ判定を持つ。変更時は両方を揃えること。
const ALLOWED = /^\/oauth\/(?:x\/authorize|(?:threads|instagram|linkedin|facebook)\/start)(?:\?[A-Za-z0-9_\-.~%=&]*)?$/;

function isSafeReturnTo(value) {
  if (typeof value !== "string" || value.length > 512) return false;
  if (!value.startsWith("/")) return false;
  if (value.includes("//") || value.includes("\\")) return false;
  return ALLOWED.test(value);
}

module.exports = { isSafeReturnTo };
