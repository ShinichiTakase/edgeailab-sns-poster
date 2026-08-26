// Stripeの実請求サイクル（billing_cycle_anchor）に基づく「決算期間」「投稿数」の共通ロジック。
// ダッシュボードの「投稿実績」「ご請求予測」両ウィジェットが、この1ファイルの
// getCurrentBillingCycle/getCombinedPostCountsだけを参照する（重複定義防止、2026-08-26新設）。
//
// カレンダー月ではなく、決算日（決済日）を境界とする「今、進行中の周期」だけを対象にする
// （両ウィジェットとも月選択プルダウンは持たない）。投稿数（従量料金・Xサーチャージ予測・
// 投稿実績の元になる件数）は次の1本の式に統一する:
//   予測投稿数 = 実績投稿数（前回決算日～今日）＋ 予定投稿数（今日～次回決算日、現在の
//                スケジュール設定が続いた場合）
// - 実績（前回決算日〜今日）: 実行済みステータスの投稿（posting_logs）
// - 予定（今日〜次回決算日）: 未実行かつスケジュール設定済みの投稿
//   （単発予約=scheduled_posts ＋ 繰り返しスケジュール=post_schedulesのシミュレーション）
// 「今日」を境に実績/予定を排他的に分けることで、同一投稿の二重計上を防ぐ。
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

// まだ決済が完了していない直近の周期番号を求める（決済日が現在時刻以降の最小のn）。
// 本稼働前（トライアル中）の顧客はn=0（最初の決済がまだ先）がそのまま該当する。
function findNextUnbilledCycleIndex(anchor, now) {
  let n = 0;
  while (addStripeStyleMonths(anchor, n) <= now) n += 1;
  return n;
}

// 「今、進行中の周期」の境界を求める。投稿実績・ご請求予測の両ウィジェットが必ずこの
// 関数経由で周期を取得することで、周期の求め方を1箇所に集約する。
// @returns {{ n: number, cycleStart: Date|null, cycleEnd: Date }|null}
//   cycleStart=null は「まだ一度も決済していない（本稼働前）」ことを示す
//   （前回決算日が存在しないため）。nullそのもの（戻り値全体）は、アンカーが
//   全く定まらない（サブスクリプションもtrialEndsAtも無い）異常系のみ。
async function getCurrentBillingCycle(stripe, customer) {
  const anchor = await getBillingCycleAnchor(stripe, customer);
  if (!anchor) return null;
  const now = new Date();
  const n = findNextUnbilledCycleIndex(anchor, now);
  const cycleEnd = addStripeStyleMonths(anchor, n);
  const cycleStart = n === 0 ? null : addStripeStyleMonths(anchor, n - 1);
  return { n, cycleStart, cycleEnd };
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
  getCurrentBillingCycle,
  getCombinedPostCounts,
};
