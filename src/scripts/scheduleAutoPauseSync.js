// トライアル終了・支払い未登録状態と、スケジュール投稿の自動停止/再開を同期するcron。
// 他のscripts/*.jsと同じ単発実行スクリプトで、cronから
// `docker compose run --rm sns-poster-schedule-auto-pause-sync` で日次起動する想定
// （実際のcrontab登録は手動実施。CLAUDE.md参照）。
//
// - トライアルが終了、または解約後の再登録直後で支払い未登録（requiresPaymentRegistration）
//   の顧客について、auto_paused=false な全スケジュールをauto_paused=trueにし、未実行の
//   生成済みscheduled_posts（source_schedule_id紐付け・pending）を取り消す。
// - 支払い登録済み等でrequiresPaymentRegistrationがfalseに戻った顧客について、
//   auto_paused=true なスケジュールをauto_paused=falseに戻す
//   （is_paused、つまりユーザー自身による一時停止には一切触れない）。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const scheduleStore = require("../lib/scheduleStore");
const { listPendingBySourceSchedule, deleteScheduledPost } = require("../lib/scheduledPostStore");
const { getCustomerById, requiresPaymentRegistration } = require("../lib/customerStore");
const { logInfo, logError } = require("../lib/logger").createLogger("schedule-auto-pause-sync.log");

// microCMSへの書き込みは並行数が多いと429（Too many requests）で弾かれるため
// （routes/schedules.jsのtexts/bulk作成時に実際に発生していた）、1件ずつ順番に削除する。
async function cancelPendingGeneratedPosts(scheduleId) {
  const pending = await listPendingBySourceSchedule(scheduleId);
  for (const p of pending) {
    await deleteScheduledPost(p.id);
  }
  return pending.length;
}

async function main() {
  const schedules = await scheduleStore.listAllSchedules();
  logInfo(`[schedule-auto-pause-sync] ${schedules.length} schedule(s) to check`);

  const customerCache = new Map();
  async function getCustomerCached(customerCode) {
    if (!customerCache.has(customerCode)) {
      customerCache.set(customerCode, await getCustomerById(customerCode));
    }
    return customerCache.get(customerCode);
  }

  let pausedCount = 0;
  let resumedCount = 0;

  for (const schedule of schedules) {
    try {
      const customer = await getCustomerCached(schedule.customer_code);
      if (!customer) continue;

      const shouldBeAutoPaused = requiresPaymentRegistration(customer);
      const isCurrentlyAutoPaused = Boolean(schedule.auto_paused);

      if (shouldBeAutoPaused && !isCurrentlyAutoPaused) {
        await scheduleStore.updateSchedule(schedule.id, { auto_paused: true });
        const canceled = await cancelPendingGeneratedPosts(schedule.id);
        pausedCount += 1;
        logInfo(`[schedule-auto-pause-sync] auto-paused scheduleId=${schedule.id} canceledPending=${canceled}`);
      } else if (!shouldBeAutoPaused && isCurrentlyAutoPaused) {
        await scheduleStore.updateSchedule(schedule.id, { auto_paused: false });
        resumedCount += 1;
        logInfo(`[schedule-auto-pause-sync] auto-resumed scheduleId=${schedule.id}`);
      }
    } catch (err) {
      logError(`[schedule-auto-pause-sync] failed scheduleId=${schedule.id}:`, err);
    }
  }

  logInfo(`[schedule-auto-pause-sync] done. paused=${pausedCount} resumed=${resumedCount}`);
}

main().catch((err) => {
  logError("[schedule-auto-pause-sync] fatal error:", err);
  process.exit(1);
});
