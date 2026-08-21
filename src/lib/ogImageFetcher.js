// Xへの画像添付投稿用。投稿文中のリンク先ページのog:imageを取得し、画像バイナリをダウンロードする。
// リンク先ページ・画像CDNのどちらも投稿文由来の任意URLになりうるため、urlTextFetcher.jsと同じ
// SSRF対策（ssrfGuard.js）を両方の取得に適用する。
// 失敗（ページ取得失敗・og:imageなし・画像形式不正等）は例外を投げず、呼び出し側でテキストのみの
// 投稿にフォールバックできるようnullを返す（Xのリンクカードはあくまで補助的な見た目の改善のため、
// 取得失敗で投稿自体を止めるべきではない）。
const { assertPublicUrl } = require("./ssrfGuard");

const FETCH_TIMEOUT_MS = 10000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // X画像アップロードの上限(5MB)に合わせる
const USER_AGENT = "Mozilla/5.0 (compatible; EdgeAILabBot/1.0; +https://edgeailab.net)";
const OG_IMAGE_PATTERN =
  /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i;

function extractOgImage(html) {
  const match = html.match(OG_IMAGE_PATTERN);
  if (!match) return null;
  return match[1] || match[2] || null;
}

async function fetchOgImage(pageUrl) {
  try {
    await assertPublicUrl(pageUrl);
    const pageRes = await fetch(pageUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!pageRes.ok) return null;
    const pageContentType = pageRes.headers.get("content-type") || "";
    if (!pageContentType.includes("text/html")) return null;

    const html = await pageRes.text();
    const ogImageUrl = extractOgImage(html);
    if (!ogImageUrl) return null;

    const absoluteImageUrl = new URL(ogImageUrl, pageUrl).toString();
    await assertPublicUrl(absoluteImageUrl);
    const imageRes = await fetch(absoluteImageUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!imageRes.ok) return null;
    const imageContentType = (imageRes.headers.get("content-type") || "").split(";")[0].trim();
    if (!/^image\/(jpeg|png|gif|webp)$/i.test(imageContentType)) return null;

    const buffer = Buffer.from(await imageRes.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null;

    return { buffer, mimeType: imageContentType };
  } catch (e) {
    return null;
  }
}

module.exports = { fetchOgImage };
