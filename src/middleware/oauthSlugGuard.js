// /oauth/{platform}/start（Xのみ /oauth/x/authorize）用のガード。
// 再認可メール等のリンクには ?slug=<対象顧客のslug> が付く。認可フロー自体はログイン中の顧客
// (req.customer) に対して行われ ?slug= は参照されないため、別の契約でログインしたまま
// リンクを開くと意図しない顧客に連携してしまう。?slug= がある場合のみ、ログイン中の顧客の
// slug（またはid。JSON/SQLiteの二重キー互換）と一致することを要求する。?slug= が無い通常導線は素通し。
const MISMATCH_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>別の契約用のリンクです</title></head>
<body><p>このリンクは別の契約用です。対象の契約でログインし直してください。</p></body></html>`;

function requireMatchingSlugParam(platform) {
  return (req, res, next) => {
    const raw = req.query.slug;
    if (raw === undefined) return next();
    const slug = Array.isArray(raw) ? "" : String(raw);
    const c = req.customer || {};
    if (slug && (slug === c.slug || slug === c.id)) return next();
    console.warn(`[oauth/${platform}] slug param mismatch: loggedInCustomerId=${c.id} param=${slug}`);
    return res.status(403).send(MISMATCH_HTML);
  };
}

module.exports = { requireMatchingSlugParam };
