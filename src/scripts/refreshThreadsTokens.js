// refreshXTokens.js / refreshInstagramTokens.js と同じ位置づけ・構造の単発実行スクリプト。
// cronから `docker compose run --rm sns-poster-threads-refresh` で都度起動する想定
// （crontab登録例はCLAUDE.md参照）。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { loadStore, savePlatformTokens } = require("../lib/tokenStore");
const { notifyFailure } = require("../lib/mailer");
const { logInfo, logWarn, logError } = require("../lib/logger").createLogger("threads.log");

// th_refresh_token は「長期(60日)トークンのリフレッシュ」専用のエンドポイントで、
// routes/threads.js の exchangeLongLivedToken が使う th_exchange_token
// （短命トークン→長期トークンへの初回交換）とは別物。
const REFRESH_TOKEN_URL = "https://graph.threads.net/refresh_access_token";

// 60日トークンのうち残り15日を切ったら更新する運用（Instagramと同じ運用ルール）。
const REFRESH_TRIGGER_MS = 15 * 24 * 60 * 60 * 1000;

async function refreshOne(slug, threadsData) {
  const url = new URL(REFRESH_TOKEN_URL);
  url.searchParams.set("grant_type", "th_refresh_token");
  url.searchParams.set("access_token", threadsData.access_token);

  const res = await fetch(url.toString());
  const json = await res.json();
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(`refresh failed: ${JSON.stringify(json)}`);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + json.expires_in * 1000);
  savePlatformTokens(slug, "threads", {
    ...threadsData,
    access_token: json.access_token,
    token_expires_at: expiresAt.toISOString(),
    updated_at: now.toISOString(),
  });
  logInfo(`[threads-refresh] refreshed slug=${slug} expires_at=${expiresAt.toISOString()}`);
}

async function main() {
  const store = loadStore();
  const now = Date.now();

  const candidates = Object.entries(store).filter(([, data]) => {
    const threads = data.threads;
    return Boolean(threads && threads.access_token && threads.token_expires_at);
  });

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const [slug, data] of candidates) {
    const threads = data.threads;
    const msUntilExpiry = new Date(threads.token_expires_at).getTime() - now;

    if (msUntilExpiry > REFRESH_TRIGGER_MS) {
      skipped++;
      continue;
    }

    try {
      await refreshOne(slug, threads);
      succeeded++;
    } catch (err) {
      failed++;
      logError(`[threads-refresh] slug=${slug} failed:`, err);
      await notifyFailure(
        `[edgeailab] Threadsトークンのリフレッシュに失敗しました (slug=${slug})`,
        [
          `slug: ${slug}`,
          `エラー: ${err.message}`,
          "",
          // threads.jsには/oauth/facebook/startやinstagram/startのようなslug指定の
          // 再認可エントリポイントが無く、callbackはMetaのOAuth同意画面からのcodeを直接受ける
          // 構造のため、再認可はMeta側の認可URLからやり直す必要がある。
          "アクセストークンが無効化されている可能性があります。Threadsの認可フローを最初からやり直して再連携してください。",
        ].join("\n")
      );
    }
  }

  logInfo(
    `[threads-refresh] summary: succeeded=${succeeded} failed=${failed} skipped=${skipped} candidates=${candidates.length}`
  );
}

main().catch((err) => {
  logError("[threads-refresh] unexpected failure:", err);
  process.exit(1);
});
