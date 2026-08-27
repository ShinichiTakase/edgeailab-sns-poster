// 予約投稿の再試行エンジン。scheduledPostRunner.js（初回実行）で投稿に失敗したもの
// （status=failed）のうち、まだ再試行回数の上限（3回）に達しておらず、かつ前回の
// 試行から3分以上経過したものだけを対象に再投稿を試みる。
// cronから `docker compose run --rm sns-poster-scheduled-post-retry-runner` で3分おきに
// 起動する想定（実際のcrontab登録は手動実施。CLAUDE.md参照）。
//
// 再試行回数・次回再試行時刻はscheduledPostRetryStore.js（json/scheduled_post_retries.json）
// で管理する。microCMS側のstatusはpending/done/failedの3値のみのため、再試行中もstatusは
// failedのまま変化しない（投稿一覧画面の「結果」列は、このstatusとretryStoreの記録を
// 組み合わせて「再試行」/「失敗」を判定する。posts.js参照）。
// 成功: status="done"に更新し、即時投稿と同じくposting_logsへ記録・Stripeメーターイベント
//       送信も行う（scheduledPostExecutor.js）。再試行の記録も削除する。
// 3回とも失敗: statusはfailedのまま据え置き、以降このエンジンの対象から外れる（永続的な失敗）。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { listFailedScheduledPosts, SCOPE_CUTOFF_AT } = require("../lib/scheduledPostStore");
const { attemptScheduledPost } = require("../lib/scheduledPostExecutor");
const retryStore = require("../lib/scheduledPostRetryStore");
const scheduleStore = require("../lib/scheduleStore");
const { sendScheduleResultEmail } = require("../lib/scheduleResultMailer");
const { sendOneShotPostResultEmail } = require("../lib/oneShotPostResultMailer");
const { logInfo, logWarn, logError } = require("../lib/logger").createLogger("scheduled-post-retry-runner.log");

async function main() {
  const failedPosts = await listFailedScheduledPosts(SCOPE_CUTOFF_AT);
  const dueForRetry = failedPosts.filter((post) => retryStore.isDueForRetry(post.id));

  if (dueForRetry.length === 0) {
    logInfo("[scheduled-post-retry-runner] no posts due for retry");
    return;
  }
  logInfo(`[scheduled-post-retry-runner] ${dueForRetry.length} post(s) due for retry`);

  const customerCache = new Map();
  let succeeded = 0;
  let failed = 0;

  for (const post of dueForRetry) {
    const platform = Array.isArray(post.platform) ? post.platform[0] : post.platform;
    try {
      const result = await attemptScheduledPost(post, customerCache, { logError });
      retryStore.clearRetry(post.id);
      succeeded += 1;
      logInfo(`[scheduled-post-retry-runner] retry succeeded id=${post.id} platform=${result.platform} customerCode=${result.customerCode}`);
    } catch (err) {
      const entry = retryStore.recordRetryFailure(post.id);
      failed += 1;
      const exhausted = entry.retryCount >= retryStore.MAX_RETRIES;
      logError(
        `[scheduled-post-retry-runner] retry failed id=${post.id} platform=${platform} customerCode=${post.customer_code} (attempt ${entry.retryCount}/${retryStore.MAX_RETRIES}${exhausted ? ", giving up" : ""}):`,
        err
      );
      // 打ち止め（再試行上限到達）になった時点が「最終結果」。この1回だけ通知メールを送る
      // （スケジュール投稿・ワンショット投稿でテンプレート・宛先解決が異なるため分岐する）。
      if (exhausted) {
        try {
          const customer = customerCache.get(post.customer_code);
          if (customer && post.source_schedule_id) {
            const schedule = await scheduleStore.getScheduleById(post.source_schedule_id);
            await sendScheduleResultEmail({ schedule, customer, post, platform, success: false, logger: { logError } });
          } else if (customer) {
            await sendOneShotPostResultEmail({
              customer,
              recipientUserId: post.created_by,
              content: post.content,
              platform,
              success: false,
              logger: { logError },
            });
          }
        } catch (mailErr) {
          logError(`[scheduled-post-retry-runner] result email failed id=${post.id}:`, mailErr);
        }
      }
    }
  }

  logInfo(`[scheduled-post-retry-runner] done. succeeded=${succeeded} failed=${failed}`);
}

main().catch((err) => {
  logError("[scheduled-post-retry-runner] fatal error:", err);
  process.exit(1);
});
