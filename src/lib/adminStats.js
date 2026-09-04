// 管理者ダッシュボード（edgeailab.net/admin/）向けの集計ロジック。
// 対象は暦月（カレンダー月、Asia/Tokyo基準。コンテナのTZ=Asia/Tokyo前提で
// DateのgetFullYear/getMonthをそのまま使う）。顧客ごとのStripe請求サイクル
// （billingCycle.jsのgetCurrentBillingCycle）とは異なる区切りである点に注意。
//
// 「前月」分は、月が変わった後は絶対に値が変わらない確定データのため、月初に
// src/scripts/adminStatsMonthlyBatch.js（cron）がjson/admin_stats_last_month.jsonへ
// 事前計算してキャッシュし、getAdminStatsはそれを読むだけにする（全顧客横断の
// 都度計算は顧客数・投稿数が増えると重くなるため。2026-09-05、ユーザー要望で
// キャッシュ化）。キャッシュが無い・月がズレている（バッチ未実行/失敗）場合のみ、
// 安全側フォールバックとしてその場で計算する。
// 「今月（今日まで）」は常に生きた値のため、キャッシュ対象外で毎回計算する。
const fs = require("fs");
const path = require("path");
const { listAllCustomers, isCanceled } = require("./customerStore");
const { getActualPostCounts } = require("./postingLogStore");
const { pricesForPlan, planKey } = require("./stripePricing");
const { computePriceAmount } = require("./stripeTierPricing");

const PLATFORMS = ["x", "threads", "facebook", "instagram", "linkedin"];
const CACHE_PATH = path.join(__dirname, "..", "..", "json", "admin_stats_last_month.json");

function emptyPlatformCounts() {
  return { x: 0, threads: 0, facebook: 0, instagram: 0, linkedin: 0 };
}

/** 指定月（0=今月、-1=前月、…）の[開始, 終了)を返す。終了は排他的（翌月1日0時）。 */
function monthRange(now, monthOffset) {
  const start = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 1);
  return { start, end };
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function readLastMonthCache() {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    const raw = fs.readFileSync(CACHE_PATH, "utf-8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error("[adminStats] failed to read cache, falling back to live calculation:", err);
    return null;
  }
}

function writeLastMonthCache(data) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// 前月中にcanceledAtが記録された顧客数。「前月の利用者数」自体（＝現在の利用者数から
// これを差し引いたもの）は「現在」が生きた値であるため、この値だけをキャッシュ対象に
// する（current自体はキャッシュしない。呼び出し側で都度 current - canceledLastMonth
// を計算すること）。
function countCanceledInMonth(customers, start, end) {
  return customers.filter((c) => {
    if (!c.canceledAt) return false;
    const t = new Date(c.canceledAt).getTime();
    return t >= start.getTime() && t < end.getTime();
  }).length;
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

// 「前月」分のスナップショットを実際に計算する（キャッシュの中身そのもの）。
// バッチスクリプト（月初実行）と、キャッシュ未生成/月ズレ時のフォールバックの両方から呼ぶ。
async function buildLastMonthSnapshot(customers, stripe, now) {
  const { start, end } = monthRange(now, -1);
  const periodStats = await computePeriodStats(customers, stripe, start, end);
  return {
    month: monthKey(start),
    generatedAt: new Date().toISOString(),
    canceledLastMonth: countCanceledInMonth(customers, start, end),
    posts: periodStats.posts,
    revenue: periodStats.revenue,
  };
}

// adminStatsMonthlyBatch.js（cron、月初起動）専用のエントリポイント。
// 顧客一覧の取得から行い、計算結果をそのままキャッシュファイルへ書き込む。
async function computeAndCacheLastMonthStats(stripe, now = new Date()) {
  const customers = await listAllCustomers();
  const snapshot = await buildLastMonthSnapshot(customers, stripe, now);
  writeLastMonthCache(snapshot);
  return snapshot;
}

async function getAdminStats(stripe) {
  const now = new Date();
  const customers = await listAllCustomers();
  const expectedLastMonthKey = monthKey(monthRange(now, -1).start);

  let lastMonthSnapshot = readLastMonthCache();
  if (!lastMonthSnapshot || lastMonthSnapshot.month !== expectedLastMonthKey) {
    if (lastMonthSnapshot) {
      console.warn(
        `[adminStats] cached last-month stats are stale (cached=${lastMonthSnapshot.month}, expected=${expectedLastMonthKey}); falling back to live calculation. Check that adminStatsMonthlyBatch.js's cron is running.`
      );
    } else {
      console.warn("[adminStats] no cached last-month stats found; falling back to live calculation. Run adminStatsMonthlyBatch.js once, or set up its cron.");
    }
    lastMonthSnapshot = await buildLastMonthSnapshot(customers, stripe, now);
  }

  const thisMonth = monthRange(now, 0);
  // 今月は月末まで待たず「今日まで」の実績のみを対象にする。生きた値のためキャッシュしない。
  const thisMonthStats = await computePeriodStats(customers, stripe, thisMonth.start, now);

  const currentUsers = customers.filter((c) => !isCanceled(c)).length;

  return {
    users: {
      current: currentUsers,
      canceledLastMonth: lastMonthSnapshot.canceledLastMonth,
      lastMonth: currentUsers - lastMonthSnapshot.canceledLastMonth,
    },
    posts: { lastMonth: lastMonthSnapshot.posts, thisMonth: thisMonthStats.posts },
    revenue: {
      lastMonth: { counts: lastMonthSnapshot.revenue.counts, total: lastMonthSnapshot.revenue.total },
      thisMonth: { counts: thisMonthStats.revenue.counts, total: thisMonthStats.revenue.total },
      xSurcharge: { lastMonth: lastMonthSnapshot.revenue.xSurcharge, thisMonth: thisMonthStats.revenue.xSurcharge },
    },
  };
}

module.exports = { getAdminStats, computeAndCacheLastMonthStats };
