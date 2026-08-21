// 顧客投稿文由来の任意URLをサーバーからfetchする箇所（urlTextFetcher.js・ogImageFetcher.js）で
// 共有するSSRF対策。プライベート/ループバック/リンクローカルアドレスへの解決を拒否する。
const dns = require("dns").promises;
const net = require("net");

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

/** urlが公開インターネット上のhttp/https URLであることを確認する。不許可なら例外をthrowする。 */
async function assertPublicUrl(url) {
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
  return parsed;
}

module.exports = { assertPublicUrl };
