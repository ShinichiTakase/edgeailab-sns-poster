// 管理者ダッシュボード（edgeailab.net/admin/）向けの集計ロジック。
// 対象は暦月（カレンダー月、Asia/Tokyo基準。コンテナのTZ=Asia/Tokyo前提で
// DateのgetFullYear/getMonthをそのまま使う）。顧客ごとのStripe請求サイクル
// （billingCycle.jsのgetCurrentBillingCycle）とは異なる区切りである点に注意。
// 全顧客を横断するため、顧客数・投稿数が増えると計算量が増える（都度計算、
// キャッシュ無し。将来重くなるようであれば、他のcronジョブと同じくバッチ集計
// してJSONにキャッシュする方式への切り替えを検討すること）。
const { listAllCustomers, isCanceled } = require("./customerStore");
const { getActualPostCounts } = require("./postingLogStore");
const { pricesForPlan, planKey } = require("./stripePricing");
const { computePriceAmount } = require("./stripeTierPricing");

const PLATFORMS = ["x", "threads", "facebook", "instagram", "linkedin"];

function emptyPlatformCounts() {
  return { x: 0, threads: 0, facebook: 0, instagram: 0, linkedin: 0 };
}

/** 指定月（0=今月、-1=前月、…）の[開始, 終了)を返す。終了は排他的（翌月1日0時）。 */
function monthRange(now, monthOffset) {
  const start = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 1);
  return { start, end };
}

// 現在の利用者数＝解約済みでない顧客数。前月の利用者数＝現在の利用者数から
// 前月中にcanceledAtが記録された顧客数を差し引いたもの（要件どおりの単純な差分。
// 新規契約分の増加は考慮しない近似値）。
function getUserCounts(customers, now) {
  const current = customers.filter((c) => !isCanceled(c)).length;
  const { start, end } = monthRange(now, -1);
  const canceledLastMonth = customers.filter((c) => {
    if (!c.canceledAt) return false;
    const t = new Date(c.canceledAt).getTime();
    return t >= start.getTime() && t < end.getTime();
  }).length;
  return { current, canceledLastMonth, lastMonth: current - canceledLastMonth };
}

/**
 * 指定期間の全顧客合算の「投稿数」（SNS毎・合計）と「売上高」（従量料金のみ、
 * 基本料金は含まない）を1回の顧客走査でまとめて計算する。
 *
 * 売上高の按分について: Stripeの従量料金は顧客ごとの「全SNS合計投稿数」に対する
 * 階層価格（例: 150件まで¥30/件、以降¥20/件）で決まり、SNS単体の金額という概念が
 * 元々存在しない。そのため「SNS毎の売上高」は、顧客ごとに計算した従量料金の合計額を、
 * その顧客のプラットフォーム別投稿数の比率で按分した近似値であり、実際の請求明細の
 * 内訳ではない。Xサーチャージは実際のX URL付き投稿数から個別に計算するため、
 * 近似ではなく正確な金額になる。
 *
 * 売上計上の対象は本稼働中（status: active）の顧客のみ（トライアル中はまだ課金
 * されておらず、解約済みはStripeサブスクリプションが既に無いため）。
 */
async function computePeriodStats(customers, stripe, start, end) {
  const postCounts = emptyPlatformCounts();
  let postTotal = 0;
  const revenueCounts = emptyPlatformCounts();
  let revenueTotal = 0;
  let xSurcharge = 0;

  if (!(start < end)) {
    return {
      posts: { counts: postCounts, total: postTotal },
      revenue: { counts: revenueCounts, total: revenueTotal, xSurcharge },
    };
  }

  // プラン（basic/standard/advanced）は最大3種類しか無いため、Stripe Price取得は
  // プランごとに1回だけ行いキャッシュする（顧客ごとに都度取得しない）。
  const priceCache = new Map();
  async function pricesForPlanCached(plan) {
    if (priceCache.has(plan)) return priceCache.get(plan);
    const ids = pricesForPlan(plan);
    const promise =
      ids && ids.metered && ids.meteredX
        ? Promise.all([
            stripe.prices.retrieve(ids.metered, { expand: ["tiers"] }),
            stripe.prices.retrieve(ids.meteredX, { expand: ["tiers"] }),
          ])
        : Promise.resolve(null);
    priceCache.set(plan, promise);
    return promise;
  }

  await Promise.all(
    customers.map(async (customer) => {
      const counts = await getActualPostCounts(customer.id, start, end);
      for (const platform of PLATFORMS) postCounts[platform] += counts.counts[platform] || 0;
      postTotal += counts.totalCount || 0;

      const status = Array.isArray(customer.status) ? customer.status[0] : customer.status;
      if (status !== "active") return;

      const plan = planKey(customer);
      const prices = plan && (await pricesForPlanCached(plan));
      if (!prices) return;
      const [meteredPrice, meteredXPrice] = prices;

      const meteredRevenue = computePriceAmount(meteredPrice, counts.totalCount);
      const xRevenue = computePriceAmount(meteredXPrice, counts.xUrlCount);
      revenueTotal += meteredRevenue;
      xSurcharge += xRevenue;

      if (counts.totalCount > 0) {
        for (const platform of PLATFORMS) {
          revenueCounts[platform] += meteredRevenue * ((counts.counts[platform] || 0) / counts.totalCount);
        }
      }
    })
  );

  for (const platform of PLATFORMS) revenueCounts[platform] = Math.round(revenueCounts[platform]);
  return {
    posts: { counts: postCounts, total: postTotal },
    revenue: { counts: revenueCounts, total: Math.round(revenueTotal), xSurcharge: Math.round(xSurcharge) },
  };
}

async function getAdminStats(stripe) {
  const now = new Date();
  const customers = await listAllCustomers();

  const lastMonth = monthRange(now, -1);
  const thisMonth = monthRange(now, 0);

  const [lastMonthStats, thisMonthStats] = await Promise.all([
    computePeriodStats(customers, stripe, lastMonth.start, lastMonth.end),
    // 今月は月末まで待たず「今日まで」の実績のみを対象にする。
    computePeriodStats(customers, stripe, thisMonth.start, now),
  ]);

  return {
    users: getUserCounts(customers, now),
    posts: { lastMonth: lastMonthStats.posts, thisMonth: thisMonthStats.posts },
    revenue: {
      lastMonth: { counts: lastMonthStats.revenue.counts, total: lastMonthStats.revenue.total },
      thisMonth: { counts: thisMonthStats.revenue.counts, total: thisMonthStats.revenue.total },
      xSurcharge: { lastMonth: lastMonthStats.revenue.xSurcharge, thisMonth: thisMonthStats.revenue.xSurcharge },
    },
  };
}

module.exports = { getAdminStats };
