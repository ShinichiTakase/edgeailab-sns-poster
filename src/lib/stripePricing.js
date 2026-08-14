// プラン⇔Stripe Price IDのマッピング。billing.js（チェックアウトセッション作成）と
// 既存customerへのXサーチャージPrice追加スクリプトの両方から参照する単一情報源。
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
  return map[plan] || null;
}

module.exports = { planKey, pricesForPlan };
