// プラン⇔Stripe Price IDのマッピング。billing.js（チェックアウトセッション作成）と
// 既存customerへのXサーチャージPrice追加スクリプトの両方から参照する単一情報源。
const { getCurrentPriceId } = require("./xSurchargeStore");

function planKey(customer) {
  // customers.plan はセレクト項目のため ["Standard"] のような配列・先頭大文字で
  // 返ってくる。ここで小文字キー（basic/standard/advanced）に正規化する。
  const value = Array.isArray(customer.plan) ? customer.plan[0] : customer.plan;
  return typeof value === "string" ? value.toLowerCase() : null;
}

function pricesForPlan(plan) {
  const map = {
    basic: {
      base: process.env.STRIPE_PRICE_BASIC_BASE,
      metered: process.env.STRIPE_PRICE_BASIC_METERED,
      meteredX: process.env.STRIPE_PRICE_BASIC_METERED_X,
    },
    standard: {
      base: process.env.STRIPE_PRICE_STANDARD_BASE,
      metered: process.env.STRIPE_PRICE_STANDARD_METERED,
      meteredX: process.env.STRIPE_PRICE_STANDARD_METERED_X,
    },
    advanced: {
      base: process.env.STRIPE_PRICE_ADVANCED_BASE,
      metered: process.env.STRIPE_PRICE_ADVANCED_METERED,
      meteredX: process.env.STRIPE_PRICE_ADVANCED_METERED_X,
    },
  };
  const prices = map[plan];
  if (!prices) return null;
  // Xサーチャージの金額変更（管理者ダッシュボード、予約日に自動適用）はStripe Priceを
  // 新規作成して差し替える方式のため、新しいPrice IDは環境変数（デプロイ時固定）ではなく
  // json/x_surcharge_current.json（xSurchargeStore.js、xSurchargeScheduleApply.js参照）に
  // 実行時に書き込まれる。適用済みならそちらを優先し、無ければ環境変数のまま。
  const overrideMeteredX = getCurrentPriceId(plan);
  return overrideMeteredX ? { ...prices, meteredX: overrideMeteredX } : prices;
}

// StripeのPrice IDから、どのプラン・どの種別（base/metered/meteredX）かを逆引きする。
// 請求情報一覧（billing.js）で、過去invoiceのline itemを②基本料金/③従量料金/④Xサーチャージに
// 分類するために使う。顧客が過去にプラン変更している場合もあるため、現在のプランだけでなく
// 全プランのPrice IDを対象に検索する。
const PLAN_LABELS_JA = { basic: "Basic", standard: "Standard", advanced: "Advanced" };

function classifyPriceId(priceId) {
  for (const plan of ["basic", "standard", "advanced"]) {
    const prices = pricesForPlan(plan);
    if (!prices) continue;
    if (prices.base === priceId) return { plan, planLabel: PLAN_LABELS_JA[plan], category: "base" };
    if (prices.metered === priceId) return { plan, planLabel: PLAN_LABELS_JA[plan], category: "metered" };
    if (prices.meteredX === priceId) return { plan, planLabel: PLAN_LABELS_JA[plan], category: "meteredX" };
  }
  return null;
}

// プラン⇔Invoice Rendering Template IDのマッピング。プランごとに請求書の項目
// グルーピング・表示順を制御するテンプレート（Stripe Dashboardで作成済み）を、
// 顧客のinvoice_settings.rendering_options.templateに設定する際に使う。
const INVOICE_TEMPLATE_ENV_KEYS = {
  basic: "STRIPE_INVOICE_TEMPLATE_BASIC",
  standard: "STRIPE_INVOICE_TEMPLATE_STANDARD",
  advanced: "STRIPE_INVOICE_TEMPLATE_ADVANCED",
};

function invoiceRenderingTemplateForPlan(plan) {
  const envKey = INVOICE_TEMPLATE_ENV_KEYS[plan];
  return (envKey && process.env[envKey]) || null;
}

module.exports = { planKey, pricesForPlan, classifyPriceId, invoiceRenderingTemplateForPlan };
