// 消費税率・計算ロジックの単一情報源（config/tax.json）。surchargeConfig.js
// （Xサーチャージ単価）と同じ構成パターンを踏襲する。
//
// 丸め方式はStripeの automatic_tax（JCT）と実機突き合わせ済み：税別合計に対して
// 「1回だけ」税率を掛けてMath.round（0.5は切り上げ）する。行ごとに個別計算して
// 合算する方式ではない（Stripe側は行ごとにも税額を配分するが、それは表示用の
// 内部按分であり、invoice.tax自体は常に「合計への一括丸め」と一致することを
// 実機で確認済み：5円+5円の2行 → 各行の配分は1円/0円と不均等だが、
// invoice.tax は round(10*0.10)=1円 に一致した）。
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "..", "config", "tax.json");

function getConsumptionTaxRate() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw).consumption_tax.rate;
}

function computeConsumptionTax(taxExclusiveSubtotalYen, rate = getConsumptionTaxRate()) {
  if (!(taxExclusiveSubtotalYen > 0)) return 0;
  return Math.round(taxExclusiveSubtotalYen * rate);
}

module.exports = { getConsumptionTaxRate, computeConsumptionTax };
