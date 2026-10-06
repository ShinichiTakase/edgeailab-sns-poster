// 顧客投稿文由来の任意URLをサーバーからfetchする箇所（urlTextFetcher.js・ogImageFetcher.js）で
// 共有するSSRF対策。プライベート/ループバック/リンクローカルアドレスへの解決を拒否する。
const dns = require("dns").promises;
const net = require("net");

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
]) blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new net.BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
// 特殊用途・トンネル経由でIPv4の検査を迂回するアドレスも拒否する。
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16]]) {
  blocked.addSubnet(address, prefix, "ipv6");
}

function isPrivateAddress(address) {
  if (net.isIP(address) === 4) {
    return blocked.check(address, "ipv4");
  }
  if (net.isIP(address) === 6) {
    return !globalV6.check(address, "ipv6") || blocked.check(address, "ipv6");
  }
  return true; // 解決できない・不明な形式は安全側に倒して拒否する
}

/** urlが公開インターネット上のhttp/https URLであることを確認する。不許可なら例外をthrowする。 */
async function resolvePublicUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new Error("invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("invalid_url_protocol");
  }
  if (parsed.username || parsed.password) throw new Error("url_not_allowed");
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const family = net.isIP(hostname);
  const addresses = family ? [{ address: hostname, family }]
    : await dns.lookup(hostname, { all: true }).catch(() => []);
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error("url_not_allowed");
  }
  return { parsed, addresses };
}

async function assertPublicUrl(url) {
  return (await resolvePublicUrl(url)).parsed;
}

module.exports = { assertPublicUrl, resolvePublicUrl, isPrivateAddress };
