// 管理者ダッシュボード（edgeailab.net/admin/）向けの集計ロジック。
// 対象は暦月（カレンダー月、Asia/Tokyo基準。コンテナのTZ=Asia/Tokyo前提で
// DateのgetFullYear/getMonthをそのまま使う）。顧客ごとのStripe請求サイクル
// （billingCycle.jsのgetCurrentBillingCycle）とは異なる区切りである点に注意。
//
// 表示データはすべて事前計算済みのSQLiteキャッシュから読む（2026-09-05、ユーザー要望で
// 「今月分もリアルタイム表示は不要」となり、リクエスト時の都度計算を全廃した）。
// getAdminStatsはHTTPリクエストの都度、全顧客横断の計算（Stripe API呼び出し含む）を
// 一切行わない。実際の計算は2本のバッチスクリプトが担う:
//   - src/scripts/adminStatsMonthlyBatch.js（月初1回）→ admin_stats_cache(last_month)
//     前月分は月が変わった後は絶対に値が変わらない確定データなので月1回で十分。
//   - src/scripts/adminStatsDailyBatch.js（毎日4時、トラフィックの少ない時間帯）
//     → admin_stats_cache(this_month)
//     今月分・現在の利用者数は生きた値だが、リアルタイム表示は不要という前提のため、
//     日次バッチの計算結果（＝最大1日遅れ）で足りる。
// キャッシュが無い・対象月がズレている（バッチ未実行/失敗）場合のみ、安全側
// フォールバックとしてgetAdminStats内でその場計算する（表示を壊さないための保険。
// 通常運用では発生しない想定）。
const { getSqliteContext } = require("../data/dataSource");
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

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function readCache(statsType) {
  try {
    const row = getSqliteContext().db.prepare(
      "SELECT payload_json FROM admin_stats_cache WHERE stats_type = ?"
    ).get(statsType);
    return row ? JSON.parse(row.payload_json) : null;
  } catch (err) {
    console.error(`[adminStats] failed to read SQLite cache ${statsType}, falling back to live calculation:`, err);
    return null;
  }
}

function writeCache(statsType, data) {
  const { db } = getSqliteContext();
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO admin_stats_cache(stats_type,period,payload_json,calculated_at,updated_at)
    VALUES(?,?,?,?,?) ON CONFLICT(stats_type) DO UPDATE SET period=excluded.period,
    payload_json=excluded.payload_json,calculated_at=excluded.calculated_at,updated_at=excluded.updated_at`)
    .run(statsType, data.month, JSON.stringify(data), data.generatedAt, timestamp);
}

// 前月中にcanceledAtが記録された顧客数。
function countCanceledInMonth(customers, start, end) {
  return customers.filter((c) => {
    if (!c.canceledAt) return false;
    const t = new Date(c.canceledAt).getTime();
    return t >= start.getTime() && t < end.getTime();
  }).length;
}

/**
 * 指定期間の全顧客合算の「投稿数」（SNS毎・合計）と「売上高」（従量料金・
 * Xサーチャージ・基本料金）を1回の顧客走査でまとめて計算する。
 *
 * 売上高の按分について: Stripeの従量料金は顧客ごとの「全SNS合計投稿数」に対する
 * 階層価格（例: 150件まで¥30/件、以降¥20/件）で決まり、SNS単体の金額という概念が
 * 元々存在しない。そのため「SNS毎の売上高」は、顧客ごとに計算した従量料金の合計額を、
 * その顧客のプラットフォーム別投稿数の比率で按分した近似値であり、実際の請求明細の
 * 内訳ではない。Xサーチャージは実際のX URL付き投稿数から個別に計算するため、
 * 近似ではなく正確な金額になる。基本料金はプランの固定額のため按分の必要が無い
 * （投稿数に依存しない合計額のみ）。
 *
 * 売上計上の対象は本稼働中（status: active）の顧客のみ（トライアル中はまだ課金
 * されておらず、解約済みはStripeサブスクリプションが既に無いため）。基本料金も
 * 同じ対象（本稼働中の顧客のみ）に対して計上する。
 */
async function computePeriodStats(customers, stripe, start, end) {
  const postCounts = emptyPlatformCounts();
  let postTotal = 0;
  const revenueCounts = emptyPlatformCounts();
  let revenueTotal = 0;
  let xSurcharge = 0;
  let baseFee = 0;

  if (!(start < end)) {
    return {
      posts: { counts: postCounts, total: postTotal },
      revenue: { counts: revenueCounts, total: revenueTotal, xSurcharge, baseFee },
    };
  }

  // プラン（basic/standard/advanced）は最大3種類しか無いため、Stripe Price取得は
  // プランごとに1回だけ行いキャッシュする（顧客ごとに都度取得しない）。
  const priceCache = new Map();
  async function pricesForPlanCached(plan) {
    if (priceCache.has(plan)) return priceCache.get(plan);
    const ids = pricesForPlan(plan);
    const promise =
      ids && ids.metered && ids.meteredX && ids.base
        ? Promise.all([
            stripe.prices.retrieve(ids.metered, { expand: ["tiers"] }),
            stripe.prices.retrieve(ids.meteredX, { expand: ["tiers"] }),
            stripe.prices.retrieve(ids.base),
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
      const [meteredPrice, meteredXPrice, basePrice] = prices;

      baseFee += basePrice.unit_amount || 0;

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
    revenue: {
      counts: revenueCounts,
      total: Math.round(revenueTotal),
      xSurcharge: Math.round(xSurcharge),
      baseFee: Math.round(baseFee),
    },
  };
}

// 「前月」分のスナップショット。月初バッチ（adminStatsMonthlyBatch.js）と、
// キャッシュ未生成/月ズレ時のフォールバックの両方から呼ぶ。
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

// 「今月（生成時点まで）」分のスナップショット。現在の利用者数もここに含める
// （どちらも「生きた値だが日次更新で足りる」という同じ性質のため）。日次バッチ
// （adminStatsDailyBatch.js）と、キャッシュ未生成/月ズレ時のフォールバックの
// 両方から呼ぶ。
async function buildThisMonthSnapshot(customers, stripe, now) {
  const { start } = monthRange(now, 0);
  const periodStats = await computePeriodStats(customers, stripe, start, now);
  return {
    month: monthKey(start),
    generatedAt: new Date().toISOString(),
    current: customers.filter((c) => !isCanceled(c)).length,
    posts: periodStats.posts,
    revenue: periodStats.revenue,
  };
}

// adminStatsMonthlyBatch.js（cron、月初起動）専用のエントリポイント。
async function computeAndCacheLastMonthStats(stripe, now = new Date()) {
  const customers = await listAllCustomers();
  const snapshot = await buildLastMonthSnapshot(customers, stripe, now);
  writeCache("last_month", snapshot);
  return snapshot;
}

// adminStatsDailyBatch.js（cron、毎日4時起動）専用のエントリポイント。
async function computeAndCacheThisMonthStats(stripe, now = new Date()) {
  const customers = await listAllCustomers();
  const snapshot = await buildThisMonthSnapshot(customers, stripe, now);
  writeCache("this_month", snapshot);
  return snapshot;
}

// 両キャッシュを読み、対象月が現在と一致していることだけ確認する。ズレていれば
// （バッチ未実行・失敗）その場でライブ計算する安全側フォールバック。通常運用では
// 発生せず、発生した場合は運用上の異常（cron停止等）を示すためconsole.warnする。
async function getAdminStats(stripe) {
  const now = new Date();
  const expectedThisMonthKey = monthKey(monthRange(now, 0).start);
  const expectedLastMonthKey = monthKey(monthRange(now, -1).start);

  let lastMonthSnapshot = readCache("last_month");
  let thisMonthSnapshot = readCache("this_month");

  // フォールバックが必要な場合のみ顧客一覧を取得する（通常運用では一切呼ばれない）。
  let customersPromise = null;
  function customersOnce() {
    if (!customersPromise) customersPromise = listAllCustomers();
    return customersPromise;
  }

  if (!lastMonthSnapshot || lastMonthSnapshot.month !== expectedLastMonthKey) {
    console.warn(
      `[adminStats] cached last-month stats ${lastMonthSnapshot ? `are stale (cached=${lastMonthSnapshot.month}, expected=${expectedLastMonthKey})` : "not found"}; falling back to live calculation. Check that adminStatsMonthlyBatch.js's cron is running.`
    );
    lastMonthSnapshot = await buildLastMonthSnapshot(await customersOnce(), stripe, now);
  }
  if (!thisMonthSnapshot || thisMonthSnapshot.month !== expectedThisMonthKey) {
    console.warn(
      `[adminStats] cached this-month stats ${thisMonthSnapshot ? `are stale (cached=${thisMonthSnapshot.month}, expected=${expectedThisMonthKey})` : "not found"}; falling back to live calculation. Check that adminStatsDailyBatch.js's cron is running.`
    );
    thisMonthSnapshot = await buildThisMonthSnapshot(await customersOnce(), stripe, now);
  }

  return {
    users: {
      current: thisMonthSnapshot.current,
      canceledLastMonth: lastMonthSnapshot.canceledLastMonth,
      lastMonth: thisMonthSnapshot.current - lastMonthSnapshot.canceledLastMonth,
    },
    posts: { lastMonth: lastMonthSnapshot.posts, thisMonth: thisMonthSnapshot.posts },
    revenue: {
      lastMonth: buildRevenueView(lastMonthSnapshot.revenue),
      thisMonth: buildRevenueView(thisMonthSnapshot.revenue),
    },
    generatedAt: { lastMonth: lastMonthSnapshot.generatedAt, thisMonth: thisMonthSnapshot.generatedAt },
  };
}

// レスポンス用に売上高の内訳を整形する。2026-09-05変更: Xサーチャージは独立した
// セクションではなく「Xの従量料金」の内訳として返す（フロント側でXの行の下に
// ネストして表示する）。基本料金も追加する。
// usageTotal = SNS毎の従量料金合計（meteredTotal）＋Xサーチャージ（＝画面上、
// Xの行とXサーチャージ行を含む全SNS行の合計と一致する値）。
// grandTotal = usageTotal ＋ 基本料金。
function buildRevenueView(revenue) {
  const usageTotal = revenue.total + revenue.xSurcharge;
  return {
    counts: revenue.counts,
    meteredTotal: revenue.total,
    xSurcharge: revenue.xSurcharge,
    usageTotal,
    baseFee: revenue.baseFee,
    grandTotal: usageTotal + revenue.baseFee,
  };
}

module.exports = { getAdminStats, computeAndCacheLastMonthStats, computeAndCacheThisMonthStats,
  _cache: { readCache, writeCache } };
