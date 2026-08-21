// 予約投稿の実行エンジン。他のscripts/*.jsと同じ位置づけ・構造の単発実行スクリプトで、
// cronから `docker compose run --rm sns-poster-scheduled-post-runner` で定期起動する想定
// （実際のcrontab登録は手動実施。CLAUDE.md参照）。
//
// scheduled_postsのうち、以下すべてを満たすものを実際にSNSへ投稿する:
//   - status = pending
//   - scheduled_at が現在時刻を過ぎている（実行すべきタイミングに達している）
//   - scheduled_at が SCOPE_CUTOFF_AT より後（このエンジン導入前に作られた予約は、
//     実際に実行される前提なしに作られたものが混在しうるため対象外とする）
//   - created_by が "test"（手動テスト投稿）ではない
// 投稿の実際の実行（成功時のstatus="done"更新・posting_logs記録・メーター送信）は
// scheduledPostExecutor.jsに共通化されている（再試行エンジンscheduledPostRetryRunner.jsと共有）。
// 失敗: status="failed"に更新し、3分後を次回再試行時刻としてscheduledPostRetryStore.jsに記録する
//       （実際の再試行はscheduledPostRetryRunner.jsが担う。最大3回、3分間隔）。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { listDuePendingScheduledPosts, markScheduledPostStatus, SCOPE_CUTOFF_AT } = require("../lib/scheduledPostStore");
const { attemptScheduledPost } = require("../lib/scheduledPostExecutor");
const retryStore = require("../lib/scheduledPostRetryStore");
const { logInfo, logWarn, logError } = require("../lib/logger").createLogger("scheduled-post-runner.log");

async function main() {
  const duePosts = await listDuePendingScheduledPosts(SCOPE_CUTOFF_AT);
  if (duePosts.length === 0) {
    logInfo("[scheduled-post-runner] no due posts");
    return;
  }
  logInfo(`[scheduled-post-runner] ${duePosts.length} due post(s) found`);

  const customerCache = new Map();
  let succeeded = 0;
  let failed = 0;

  for (const post of duePosts) {
    const platform = Array.isArray(post.platform) ? post.platform[0] : post.platform;
    try {
      const result = await attemptScheduledPost(post, customerCache, { logError });
      succeeded += 1;
      logInfo(`[scheduled-post-runner] posted id=${post.id} platform=${result.platform} customerCode=${result.customerCode}`);
    } catch (err) {
      failed += 1;
      logError(`[scheduled-post-runner] failed id=${post.id} platform=${platform} customerCode=${post.customer_code}:`, err);
      try {
        await markScheduledPostStatus(post.id, "failed");
        retryStore.recordInitialFailure(post.id);
      } catch (markErr) {
        logError(`[scheduled-post-runner] failed to mark status=failed id=${post.id}:`, markErr);
      }
    }
  }

  logInfo(`[scheduled-post-runner] done. succeeded=${succeeded} failed=${failed}`);
}

main().catch((err) => {
  logError("[scheduled-post-runner] fatal error:", err);
  process.exit(1);
});
