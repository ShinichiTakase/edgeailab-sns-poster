// refreshXTokens.js と同じ位置づけ・構造の単発実行スクリプト。
// cronから `docker compose run --rm sns-poster-instagram-refresh` で都度起動する想定
// （crontab登録例はCLAUDE.md参照）。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { loadStore, savePlatformTokens } = require("../lib/tokenStore");
const { notifyFailure } = require("../lib/mailer");
const { logInfo, logWarn, logError } = require("../lib/logger").createLogger("instagram.log");

// ig_refresh_token は「長期(60日)トークンのリフレッシュ」専用のエンドポイントで、
// routes/instagram.js の exchangeLongLivedToken が使う ig_exchange_token
// （短命トークン→長期トークンへの初回交換）とは別物。バージョン接頭辞も付かない。
const REFRESH_TOKEN_URL = "https://graph.instagram.com/refresh_access_token";

// 60日トークンのうち残り15日を切ったら更新する運用（Threadsのday45-50リフレッシュに合わせる）。
const REFRESH_TRIGGER_MS = 15 * 24 * 60 * 60 * 1000;

// Instagramの長期トークンリフレッシュは「発行から24時間以上経過したトークン」が条件。
// updated_atは直近のトークン発行/リフレッシュ時刻と一致するため、これを発行時刻として扱う。
const MIN_TOKEN_AGE_MS = 24 * 60 * 60 * 1000;

async function refreshOne(slug, igData) {
  const url = new URL(REFRESH_TOKEN_URL);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", igData.access_token);

  const res = await fetch(url.toString());
  const json = await res.json();
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(`refresh failed: ${JSON.stringify(json)}`);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + json.expires_in * 1000);
  savePlatformTokens(slug, "instagram", {
    ...igData,
    access_token: json.access_token,
    token_expires_at: expiresAt.toISOString(),
    updated_at: now.toISOString(),
  });
  logInfo(`[instagram-refresh] refreshed slug=${slug} expires_at=${expiresAt.toISOString()}`);
}

async function main() {
  const store = loadStore();
  const now = Date.now();

  const candidates = Object.entries(store).filter(([, data]) => {
    const ig = data.instagram;
    return Boolean(ig && ig.access_token && ig.token_expires_at);
  });

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const [slug, data] of candidates) {
    const ig = data.instagram;
    const msUntilExpiry = new Date(ig.token_expires_at).getTime() - now;

    if (msUntilExpiry > REFRESH_TRIGGER_MS) {
      skipped++;
      continue;
    }

    const tokenAgeMs = ig.updated_at ? now - new Date(ig.updated_at).getTime() : Infinity;
    if (tokenAgeMs < MIN_TOKEN_AGE_MS) {
      logWarn(
        `[instagram-refresh] slug=${slug} skipped: token issued less than 24h ago (age=${Math.round(
          tokenAgeMs / 1000
        )}s)`
      );
      skipped++;
      continue;
    }

    try {
      await refreshOne(slug, ig);
      succeeded++;
    } catch (err) {
      failed++;
      logError(`[instagram-refresh] slug=${slug} failed:`, err);
      await notifyFailure(
        `[edgeailab] Instagramトークンのリフレッシュに失敗しました (slug=${slug})`,
        [
          `slug: ${slug}`,
          `エラー: ${err.message}`,
          "",
          "アクセストークンが無効化されている可能性があります。ブラウザで以下にアクセスして再認可してください:",
          `https://edgeailab.net/oauth/instagram/start?slug=${encodeURIComponent(slug)}`,
        ].join("\n")
      );
    }
  }

  logInfo(
    `[instagram-refresh] summary: succeeded=${succeeded} failed=${failed} skipped=${skipped} candidates=${candidates.length}`
  );
}

main().catch((err) => {
  logError("[instagram-refresh] unexpected failure:", err);
  process.exit(1);
});
