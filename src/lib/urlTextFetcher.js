// URL指定によるAI文案生成のため、サーバーサイドで実際にページ本文を取得する。
// （URL文字列だけをAIプロンプトに渡して「読んだふり」の生成をさせることを禁止する要件のため、
// 必ずここで実際にHTTPリクエストして本文を取得してからpostCopyGenerator.jsへ渡す）。
const dns = require("dns").promises;
const net = require("net");

const FETCH_TIMEOUT_MS = 10000;
const MAX_TEXT_LENGTH = 8000;
const USER_AGENT = "Mozilla/5.0 (compatible; EdgeAILabBot/1.0; +https://edgeailab.net)";

// 顧客が指定した任意のURLをサーバーからfetchするため、SSRF対策として
// プライベート/ループバック/リンクローカルアドレスへの解決を拒否する。
function isPrivateAddress(address) {
  if (net.isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 0) return true;
    return false;
  }
  if (net.isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("fe80:")) return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    return false;
  }
  return true; // 解決できない・不明な形式は安全側に倒して拒否する
}

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
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new Error("invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("invalid_url_protocol");
  }

  const addresses = await dns.lookup(parsed.hostname, { all: true }).catch(() => []);
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error("url_not_allowed");
  }

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
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
