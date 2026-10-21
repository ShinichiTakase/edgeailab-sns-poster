// /oauth/{platform}/start（Xのみ /oauth/x/authorize）用のガード。
// 再認可メール等のリンクには ?slug=<対象顧客のslug> が付く。認可フロー自体はログイン中の顧客
// (req.customer) に対して行われ ?slug= は参照されないため、別の契約でログインしたまま
// リンクを開くと意図しない顧客に連携してしまう。?slug= がある場合のみ、ログイン中の顧客の
// slug（またはid。JSON/SQLiteの二重キー互換）と一致することを要求する。?slug= が無い通常導線は素通し。
const { isSafeReturnTo } = require("../lib/returnTo");

// 不一致画面。誤った契約でログイン中のため、ログアウトして対象契約でログインし直す導線を付ける。
// ログアウト後は同じ認可URL(returnTo)へ戻る。returnToは許可リスト一致のときだけ埋め込む。
function mismatchHtml(originalUrl) {
  const returnTo = isSafeReturnTo(originalUrl) ? encodeURIComponent(originalUrl) : "";
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>別の契約用のリンクです</title></head>
<body><p>このリンクは別の契約用です。対象の契約でログインし直してください。</p>
<p><button type="button" id="relogin" data-return-to="${returnTo}">ログアウトして対象契約でログインする</button></p>
<script>
document.getElementById("relogin").addEventListener("click", async () => {
  const r = document.getElementById("relogin").dataset.returnTo;
  try { await fetch("/api/auth/logout", { method: "POST", credentials: "include" }); } catch (e) {}
  location.href = "/login.html" + (r ? "?returnTo=" + r : "");
});
</script></body></html>`;
}

function requireMatchingSlugParam(platform) {
  return (req, res, next) => {
    const raw = req.query.slug;
    if (raw === undefined) return next();
    const slug = Array.isArray(raw) ? "" : String(raw);
    const c = req.customer || {};
    if (slug && (slug === c.slug || slug === c.id)) return next();
    console.warn(`[oauth/${platform}] slug param mismatch: loggedInCustomerId=${c.id} param=${slug}`);
    return res.status(403).send(mismatchHtml(req.originalUrl));
  };
}

module.exports = { requireMatchingSlugParam };
