// URL指定によるAI文案生成のため、サーバーサイドで実際にページ本文を取得する。
// （URL文字列だけをAIプロンプトに渡して「読んだふり」の生成をさせることを禁止する要件のため、
// 必ずここで実際にHTTPリクエストして本文を取得してからpostCopyGenerator.jsへ渡す）。
const { fetchPublicResource } = require("./publicUrlFetcher");

const MAX_TEXT_LENGTH = 8000;

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
    console.log(`[timing] urlTextFetcher.fetchUrlText durationMs=${Date.now() - __t0}`);
  }
}

async function fetchUrlTextInner(url) {
  const res = await fetchPublicResource(url);
  if (!res.ok) {
    throw new Error(`fetch_failed_${res.status}`);
  }
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    throw new Error("unsupported_content_type");
  }

  const html = res.body.toString("utf8");
  const text = stripHtml(html);
  if (!text) {
    throw new Error("empty_content");
  }
  return text.slice(0, MAX_TEXT_LENGTH);
}

module.exports = { fetchUrlText };
