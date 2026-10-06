// 管理者ダッシュボード（edgeailab.net/admin/）の「今月（今日まで）」分・現在の利用者数を
// 日次バッチで計算し、SQLite admin_stats_cacheへキャッシュする。今月分は
// 生きた値（毎日増える）だが、ダッシュボード表示にリアルタイム性は不要という前提のため
// （2026-09-05、ユーザー要望）、トラフィックの少ない時間帯に1日1回計算すれば足りる
// （src/lib/adminStats.js の getAdminStats 参照。キャッシュが無い/月がズレている場合は
// 同ファイル内で安全側フォールバックとしてその場で計算する）。
//
// 他のcronジョブ（scheduledPostRetryRunner.js等）と同じ位置づけの単発実行スクリプト。
// cronから `docker compose run --rm sns-poster-admin-stats-daily-batch` で
// 毎日4時（トラフィックの少ない時間帯）に起動する想定（実際のcrontab登録は手動実施。
// CLAUDE.md参照）。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { getStripe } = require("../lib/stripeClient");
const { computeAndCacheThisMonthStats } = require("../lib/adminStats");
const { logInfo, logError } = require("../lib/logger").createLogger("admin-stats-daily-batch.log");

async function main() {
  const stripe = getStripe();
  if (!stripe) {
    logError("[admin-stats-daily-batch] stripe not configured");
    process.exit(1);
  }

  const snapshot = await computeAndCacheThisMonthStats(stripe);
  logInfo(
    `[admin-stats-daily-batch] cached month=${snapshot.month} current=${snapshot.current} posts=${snapshot.posts.total} revenueTotal=${snapshot.revenue.total} xSurcharge=${snapshot.revenue.xSurcharge}`
  );
}

main().catch((err) => {
  logError("[admin-stats-daily-batch] fatal error:", err);
  process.exit(1);
});
