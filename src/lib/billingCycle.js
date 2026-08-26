// Stripeの実請求サイクル（billing_cycle_anchor）に基づく「月」「投稿数」の共通ロジック。
// ご請求予測（billing.js）・投稿予定（posts.js）の両方で使う（2026-08-26新設）。
//
// 「月」はカレンダー月ではなく、決済日を境界とする周期として扱う。基本料金は先払い
// （決済日にその日から始まる次周期分を課金）。投稿数（従量料金・Xサーチャージ・投稿予定
// 表示の元になる件数）は「直近の決済日〜今回の決済日」の実績＋予測の合算として扱う:
// - 既に経過した分（周期開始〜今日）は実行済み投稿（posting_logs）の実績
// - まだ経過していない分（今日〜周期終了）は、現在のスケジュール設定が続いた場合の予測
//   （単発予約=scheduled_posts ＋ 繰り返しスケジュール=post_schedulesのシミュレーション）
const { getScheduledPostsSummary } = require("./scheduledPostStore");
const { getActualPostCounts } = require("./postingLogStore");
const { listSchedulesForCustomer } = require("./scheduleStore");
const { listScheduleTexts } = require("./scheduleTextStore");
const { estimateScheduleFirings } = require("./scheduleForecast");

function emptyCounts() {
  return { counts: { x: 0, threads: 0, facebook: 0, instagram: 0, linkedin: 0 }, xUrlCount: 0, totalCount: 0 };
}

function mergeCounts(...parts) {
  const merged = emptyCounts();
  for (const part of parts) {
    for (const key of Object.keys(merged.counts)) {
      merged.counts[key] += (part.counts && part.counts[key]) || 0;
    }
    merged.xUrlCount += part.xUrlCount || 0;
    merged.totalCount += part.totalCount || 0;
  }
  return merged;
}

// customer.trialEndsAtは決済登録（Checkout完了）後もクリアされず残り続ける内部値であり、
// 実際の請求サイクルとズレていた実例があるため、既にStripeサブスクリプションが存在する
// 顧客には使わない。実際のsubscription.billing_cycle_anchorを正とする。まだCheckout
// 未完了（トライアル中）の顧客のみ、trialEndsAt+1日を将来のアンカー予測値として使う。
async function getBillingCycleAnchor(stripe, customer) {
  if (customer.stripeSubscriptionId) {
    try {
      const subscription = await stripe.subscriptions.retrieve(customer.stripeSubscriptionId);
      return new Date(subscription.billing_cycle_anchor * 1000);
    } catch (err) {
      console.error(`[billingCycle] failed to retrieve subscription for anchor customerId=${customer.id}:`, err);
      return null;
    }
  }
  if (!customer.trialEndsAt) return null;
  return new Date(new Date(customer.trialEndsAt).getTime() + 24 * 60 * 60 * 1000);
}

// アンカー日時からn周期後の決済日を求める。Stripeの実際の月次課金アンカーの挙動
// （日単位・当月に該当日が無ければその月の最終日に丸める。例: 起点1/31なら2月は2/28）に
// 合わせる（実機検証済みのStripe挙動。CLAUDE.md参照）。
function addStripeStyleMonths(anchor, n) {
  const day = anchor.getDate();
  const base = new Date(
    anchor.getFullYear(),
    anchor.getMonth() + n,
    1,
    anchor.getHours(),
    anchor.getMinutes(),
    anchor.getSeconds(),
    anchor.getMilliseconds()
  );
  const daysInTargetMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  base.setDate(Math.min(day, daysInTargetMonth));
  return base;
}

// 指定したカレンダー年月に決済日が属する周期番号nを求める（n=0が最初の決済＝本稼働開始日、
// nがnullなら対象月に決済日が存在しない＝範囲外）。月次サイクルのため該当月には必ず
// ちょうど1つの決済日が存在する前提で、概算位置の前後1周期のみ確認すれば十分。
function findCycleIndexForMonth(anchor, year, month) {
  const approx = year * 12 + (month - 1) - (anchor.getFullYear() * 12 + anchor.getMonth());
  for (const n of [approx - 1, approx, approx + 1]) {
    const d = addStripeStyleMonths(anchor, n);
    if (d.getFullYear() === year && d.getMonth() === month - 1) return n;
  }
  return null;
}

// まだ決済が完了していない直近の周期番号を求める（決済日が現在時刻以降の最小のn）。
// 本稼働前（トライアル中）の顧客はn=0（最初の決済がまだ先）がそのまま該当する。
function findNextUnbilledCycleIndex(anchor, now) {
  let n = 0;
  while (addStripeStyleMonths(anchor, n) <= now) n += 1;
  return n;
}

// 対象期間内で、この顧客の全スケジュール投稿（post_schedules）が生成するはずの投稿予定を
// 合算する（1件ずつの単発予約=scheduled_postsとは別集計。estimateScheduleFirings参照）。
async function getScheduleForecastForCustomer(customerId, windowStart, windowEnd) {
  const schedules = await listSchedulesForCustomer(customerId);
  const parts = await Promise.all(
    schedules.map(async (schedule) => {
      const texts = await listScheduleTexts(schedule.id);
      return estimateScheduleFirings(schedule, texts, windowStart, windowEnd);
    })
  );
  return mergeCounts(...parts);
}

// windowStart〜windowEndの投稿数を、実績（今日まで。posting_logs）＋予測（今日から先。
// 単発予約=scheduled_posts＋繰り返しスケジュールのシミュレーション）で合算する。
// windowStartが未来（周期全体が未来）なら実績部分は自動的に空になり、windowEndが過去
// （周期が既に終わっている）なら予測部分は自動的に空になる。
async function getCombinedPostCounts(customer, windowStart, windowEnd) {
  const now = new Date();
  const actualEnd = now < windowEnd ? now : windowEnd;
  const projectedStart = now > windowStart ? now : windowStart;

  const [actual, oneOff, recurring] = await Promise.all([
    actualEnd > windowStart ? getActualPostCounts(customer.id, windowStart, actualEnd) : emptyCounts(),
    projectedStart < windowEnd ? getScheduledPostsSummary(customer.id, projectedStart, windowEnd) : emptyCounts(),
    projectedStart < windowEnd ? getScheduleForecastForCustomer(customer.id, projectedStart, windowEnd) : emptyCounts(),
  ]);

  return mergeCounts(actual, oneOff, recurring);
}

module.exports = {
  getBillingCycleAnchor,
  addStripeStyleMonths,
  findCycleIndexForMonth,
  findNextUnbilledCycleIndex,
  getCombinedPostCounts,
};
