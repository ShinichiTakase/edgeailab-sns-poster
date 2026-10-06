// 任意URL取得の共通経路。DNS検証と接続先を一致させ、全redirectを再検証する。
// SNS/Stripeの認証付きAPI通信には使用しない。
const http = require("node:http");
const https = require("node:https");
const { resolvePublicUrl } = require("./ssrfGuard");

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = "Mozilla/5.0 (compatible; EdgeAILabBot/1.0; +https://edgeailab.net)";

function requestOnce(parsed, addresses, signal, maxBytes) {
  return new Promise((resolve, reject) => {
    const transport = parsed.protocol === "https:" ? https : http;
    const request = transport.get(parsed, {
      signal,
      agent: false,
      headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "identity" },
      // 検証済みIPだけを返す。HostとTLS証明書/SNIの検証対象は元のhostnameを維持。
      lookup(_hostname, options, callback) {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
    }, (response) => {
      response.on("error", reject);
      const status = response.statusCode;
      const result = { status, ok: status >= 200 && status < 300,
        headers: new Headers(response.headers), url: parsed.href };
      if (REDIRECT_STATUSES.has(status) || !result.ok) {
        resolve({ ...result, body: Buffer.alloc(0) });
        response.destroy();
        return;
      }
      let size = 0;
      const chunks = [];
      if (Number(response.headers["content-length"]) > maxBytes) {
        reject(new Error("response_too_large"));
        response.destroy();
        return;
      }
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(new Error("response_too_large"));
          response.destroy();
        } else chunks.push(chunk);
      });
      response.on("end", () => resolve({ ...result, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject);
  });
}

async function fetchPublicResource(url, { maxBytes = MAX_HTML_BYTES, timeoutMs = 10000, maxRedirects = 5 } = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("fetch_timeout"));
      controller.abort();
    }, timeoutMs);
  });
  const run = async () => {
    let current = url;
    for (let count = 0; ; count += 1) {
      const { parsed, addresses } = await resolvePublicUrl(current);
      if (controller.signal.aborted) throw new Error("fetch_timeout");
      const response = await requestOnce(parsed, addresses, controller.signal, maxBytes);
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get("location");
      if (!location || count >= maxRedirects) throw new Error("redirect_limit");
      current = new URL(location, parsed).href;
    }
  };
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchPublicResource };
