// URL指定によるAI文案生成のため、サーバーサイドで実際にページ本文を取得する。
// （URL文字列だけをAIプロンプトに渡して「読んだふり」の生成をさせることを禁止する要件のため、
// 必ずここで実際にHTTPリクエストして本文を取得してからpostCopyGenerator.jsへ渡す）。
const { assertPublicUrl } = require("./ssrfGuard");

const FETCH_TIMEOUT_MS = 10000;
const MAX_TEXT_LENGTH = 8000;
const USER_AGENT = "Mozilla/5.0 (compatible; EdgeAILabBot/1.0; +https://edgeailab.net)";

function stripHtml(html) {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, " ");
  const decoded = withoutTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return decoded.replace(/\s+/g, " ").trim();
}

/** 指定URLの本文テキストを実際に取得する（先頭MAX_TEXT_LENGTH文字まで）。 */
async function fetchUrlText(url) {
  // 体感速度の遅さの原因切り分け調査用（2026-08-20）。URL fetch単体の所要時間を計測する。
  const __t0 = Date.now();
  try {
    return await fetchUrlTextInner(url);
  } finally {
    console.log(`[timing] urlTextFetcher.fetchUrlText durationMs=${Date.now() - __t0} url=${url}`);
  }
}

async function fetchUrlTextInner(url) {
  await assertPublicUrl(url);

  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    // AbortSignal.timeout()由来の中断はe.name === "TimeoutError"（Node 20のfetch実装で確認済み）。
    // それ以外（DNS解決失敗・接続拒否等）はTypeError("fetch failed")になる。
    if (e.name === "TimeoutError") {
      throw new Error("fetch_timeout");
    }
    throw new Error("network_error");
  }
  if (!res.ok) {
    throw new Error(`fetch_failed_${res.status}`);
  }
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    throw new Error("unsupported_content_type");
  }

  const html = await res.text();
  const text = stripHtml(html);
  if (!text) {
    throw new Error("empty_content");
  }
  return text.slice(0, MAX_TEXT_LENGTH);
}

module.exports = { fetchUrlText };
