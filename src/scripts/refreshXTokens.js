const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { loadStore, savePlatformTokens } = require("../lib/tokenStore");
const { notifyFailure } = require("../lib/mailer");

const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const REFRESH_WINDOW_MS = 15 * 60 * 1000;

function basicAuthHeader() {
  const raw = `${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

async function refreshOne(slug, xData) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: xData.refresh_token,
      client_id: process.env.X_CLIENT_ID,
    }),
  });
  const json = await res.json();
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(`refresh failed: ${JSON.stringify(json)}`);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + json.expires_in * 1000);
  savePlatformTokens(slug, "x", {
    ...xData,
    access_token: json.access_token,
    // Xはリフレッシュ時にrefresh_tokenをローテーションする場合があるため、
    // 返ってきていれば必ず上書きする。
    refresh_token: json.refresh_token || xData.refresh_token,
    token_expires_at: expiresAt.toISOString(),
    updated_at: now.toISOString(),
  });
  console.info(`[x-refresh] refreshed slug=${slug} expires_at=${expiresAt.toISOString()}`);
}

async function main() {
  const store = loadStore();
  const now = Date.now();
  const seen = new Set();
  const targets = Object.entries(store).filter(([, data]) => {
    const x = data.x;
    if (!x || !x.refresh_token || !x.token_expires_at) return false;
    if (new Date(x.token_expires_at).getTime() - now > REFRESH_WINDOW_MS) return false;
    const accountKey = String(x.user_id || x.username || x.refresh_token);
    if (seen.has(accountKey)) return false;
    seen.add(accountKey);
    return true;
  });

  if (targets.length === 0) {
    console.info("[x-refresh] no tokens due for refresh");
    return;
  }

  for (const [slug, data] of targets) {
    try {
      await refreshOne(slug, data.x);
    } catch (err) {
      console.error(`[x-refresh] slug=${slug} failed:`, err);
      await notifyFailure(
        `[edgeailab] Xトークンのリフレッシュに失敗しました (slug=${slug})`,
        [
          `slug: ${slug}`,
          `エラー: ${err.message}`,
          "",
          "refresh_tokenが無効化されている可能性があります。ブラウザで以下にアクセスして再認可してください:",
          `https://edgeailab.net/oauth/x/authorize?slug=${encodeURIComponent(slug)}`,
        ].join("\n")
      );
    }
  }
}

if (require.main === module) main().catch((err) => {
  console.error("[x-refresh] unexpected failure:", err);
  process.exit(1);
});

module.exports = { main, refreshOne };
