// 管理者ダッシュボード（edgeailab.net/admin/）の「前月」分集計（利用者数・投稿数・
// 売上高）を月初にバッチで計算し、SQLite admin_stats_cacheへキャッシュする。
// 前月分は月が変わった後は絶対に値が変わらない確定データのため、ダッシュボード
// 表示のたびに全顧客横断で都度計算せず、このキャッシュから読む
// （src/lib/adminStats.js の getAdminStats 参照。キャッシュが無い/月がズレている
// 場合は同ファイル内で安全側フォールバックとしてその場で計算する）。
//
// 他のcronジョブ（scheduledPostRetryRunner.js等）と同じ位置づけの単発実行スクリプト。
// cronから `docker compose run --rm sns-poster-admin-stats-monthly-batch` で
// 毎月1日に起動する想定（実際のcrontab登録は手動実施。CLAUDE.md参照）。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { getStripe } = require("../lib/stripeClient");
const { computeAndCacheLastMonthStats } = require("../lib/adminStats");
const { logInfo, logError } = require("../lib/logger").createLogger("admin-stats-monthly-batch.log");

async function main() {
  const stripe = getStripe();
  if (!stripe) {
    logError("[admin-stats-monthly-batch] stripe not configured");
    process.exit(1);
  }

  const snapshot = await computeAndCacheLastMonthStats(stripe);
  logInfo(
    `[admin-stats-monthly-batch] cached month=${snapshot.month} posts=${snapshot.posts.total} revenueTotal=${snapshot.revenue.total} xSurcharge=${snapshot.revenue.xSurcharge} canceledLastMonth=${snapshot.canceledLastMonth}`
  );
}

main().catch((err) => {
  logError("[admin-stats-monthly-batch] fatal error:", err);
  process.exit(1);
});
