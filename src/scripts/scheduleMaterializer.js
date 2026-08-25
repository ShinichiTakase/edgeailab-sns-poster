// スケジュール投稿の「工場」cron。他のscripts/*.jsと同じ単発実行スクリプトで、
// cronから `docker compose run --rm sns-poster-schedule-materializer` で
// 10分おきに起動する想定（実際のcrontab登録は手動実施。CLAUDE.md参照）。
//
// 稼働中（is_paused/auto_pausedいずれも偽）の各スケジュールについて、当日がまだ
// materializeされていなければ、曜日パターン・投稿期間に一致する場合のみ当日分の
// scheduled_posts（source_schedule_id付き）を実際に生成する。生成した予約は
// 既存のscheduledPostRunner.js（10分おき実行中）がそのまま拾って実投稿するため、
// ここでは投稿処理そのものは一切書かない。
//
// 冪等性: last_materialized_dt（YYYY-MM-DD）が当日と一致するスケジュールはスキップする。
// 1日の実消化数は effectiveDailyCount()（設定回数・設定枠数・登録済み投稿文章数の最小値）
// で自動的にクランプされ、同日内で同じ文章が2回使われることはない。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const scheduleStore = require("../lib/scheduleStore");
const scheduleTextStore = require("../lib/scheduleTextStore");
const { createScheduledPost } = require("../lib/scheduledPostStore");
const { getConnectedEntry } = require("../lib/tokenStore");
const { getCustomerById, isTrialPostLimitReached, isCanceled, requiresPaymentRegistration } = require("../lib/customerStore");
const { activateAfterTrialLimitIfNeeded, sendTrialPostLimitReachedEmailIfNeeded } = require("../lib/trialLimitAutoActivation");
const { containsUrl } = require("../lib/urlDetection");
const {
  matchesWeekday,
  isDateInScheduleRange,
  getConfiguredSlots,
  effectiveDailyCount,
  pickRandomTimeInSlot,
  dateOnly,
} = require("../lib/scheduleFiring");
const { logInfo, logError } = require("../lib/logger").createLogger("schedule-materializer.log");

function todayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function main() {
  const now = new Date();
  const today = dateOnly(now);
  const todayKeyStr = todayKey(today);

  const schedules = await scheduleStore.listActiveSchedules();
  logInfo(`[schedule-materializer] ${schedules.length} active schedule(s) to check`);

  const customerCache = new Map();
  async function getCustomerCached(customerCode) {
    if (!customerCache.has(customerCode)) {
      customerCache.set(customerCode, await getCustomerById(customerCode));
    }
    return customerCache.get(customerCode);
  }

  let materializedCount = 0;
  let generatedPostCount = 0;

  for (const schedule of schedules) {
    try {
      if (schedule.last_materialized_dt && todayKey(new Date(schedule.last_materialized_dt)) === todayKeyStr) {
        continue; // 本日分は生成済み
      }
      if (!matchesWeekday(schedule, today) || !isDateInScheduleRange(schedule, today)) {
        continue; // 今日は対象曜日でない、または投稿期間外
      }

      const customer = await getCustomerCached(schedule.customer_code);
      if (!customer) {
        logError(`[schedule-materializer] customer not found scheduleId=${schedule.id} customerCode=${schedule.customer_code}`);
        continue;
      }
      // トライアル投稿上限・解約は生成時点でも確認する（実行時にもscheduledPostRunner.js側で
      // 再確認するため二重チェックになるが、無駄な予約生成を避けるためここでも弾く）。
      if (isCanceled(customer) || requiresPaymentRegistration(customer)) {
        continue;
      }
      if (isTrialPostLimitReached(customer)) {
        // requireUnderTrialPostLimit（requireAuth.js）・scheduledPostExecutor.jsと
        // 同じ救済経路（2026-08-25追加）。60通到達後にpayment.htmlでカードだけ
        // 登録しておいた顧客が、次のmaterializer実行タイミングで自動的に本契約へ
        // 切り替わり、当日分の予約生成が再開されるようにする。
        const result = await activateAfterTrialLimitIfNeeded({ customer, logger: { logError } });
        if (result === "activated") {
          customer.status = ["active"];
          await sendTrialPostLimitReachedEmailIfNeeded({ customer, result, logger: { logError } });
        } else {
          continue;
        }
      }

      // 承認待ち・却下・失効中のバッチ（編集者作成分）は自動生成プールから除外する
      // （scheduleTextStore.listApprovedScheduleTexts参照）。
      const texts = await scheduleTextStore.listApprovedScheduleTexts(schedule.id);
      const n = effectiveDailyCount(schedule, texts.length);
      if (n === 0) {
        // 投稿文章が未登録、または枠が未設定。生成する予約がないだけで、
        // last_materialized_dtは更新しない（後で文章が追加されたら翌ティックで拾えるように）。
        continue;
      }

      const slots = getConfiguredSlots(schedule).slice(0, n);
      const platforms = Array.isArray(schedule.platforms) ? schedule.platforms : [];
      // SNS連携解除後、post_schedules.platformsに解除済みのプラットフォームが残ったままでも
      // ここで新規生成をスキップする（連携解除時のpending予約キャンセルとは別の対応。
      // 解除時点の既存予約は snsConnections.js の disconnect ハンドラが取り消すが、
      // post_schedules定義自体は変更しないため、このガードが無いと翌日以降も
      // 未接続のプラットフォーム宛てにscheduled_postsが生成され続け、実行時に
      // not_connectedで失敗し続けることになる）。
      const connectedEntry = getConnectedEntry(schedule.customer_code);
      let roundRobinIndex = Number(schedule.round_robin_index) || 0;

      for (let i = 0; i < n; i++) {
        const text = texts[roundRobinIndex % texts.length];
        const scheduledAt = pickRandomTimeInSlot(today, slots[i]);

        for (const platform of platforms) {
          if (!connectedEntry[platform]) continue; // 連携解除済みのプラットフォームは生成しない

          const platformTextKey = {
            x: "x_text",
            threads: "threads_text",
            facebook: "facebook_text",
            instagram: "instagram_text",
            linkedin: "linkedin_text",
          }[platform];
          const content = text[platformTextKey] || "";
          if (!content.trim()) continue; // このプラットフォーム分の文章が未入力ならスキップ

          await createScheduledPost({
            customerCode: schedule.customer_code,
            createdBy: schedule.created_by,
            platform,
            content,
            scheduledAt: scheduledAt.toISOString(),
            containsUrl: containsUrl(content),
            imageUrl: platform === "instagram" ? text.instagram_image_url : undefined,
            videoUrl: platform === "instagram" ? text.instagram_video_url : undefined,
            sourceScheduleId: schedule.id,
            facebookPageId: platform === "facebook" ? schedule.facebook_page_id || undefined : undefined,
          });
          generatedPostCount += 1;
        }

        roundRobinIndex += 1;
      }

      await scheduleStore.updateSchedule(schedule.id, {
        round_robin_index: roundRobinIndex,
        last_materialized_dt: today.toISOString(),
      });
      materializedCount += 1;
      logInfo(`[schedule-materializer] materialized scheduleId=${schedule.id} firings=${n}`);
    } catch (err) {
      logError(`[schedule-materializer] failed scheduleId=${schedule.id}:`, err);
    }
  }

  logInfo(
    `[schedule-materializer] done. schedulesMaterialized=${materializedCount} scheduledPostsCreated=${generatedPostCount}`
  );
}

main().catch((err) => {
  logError("[schedule-materializer] fatal error:", err);
  process.exit(1);
});
