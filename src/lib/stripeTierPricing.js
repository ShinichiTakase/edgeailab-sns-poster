// Stripeの段階制（graduated）Priceのtiersから、指定数量の請求額を計算する。
// 実際のtier構成（単価・閾値）はStripe側のPrice定義を唯一の情報源とし、
// ここにはハードコードしない（config/planLimits.json・surcharge.jsonのような
// ローカルJSONとの二重管理・乖離を避けるため、stripePricing.jsのPrice IDから
// stripe.prices.retrieve(..., {expand:["tiers"]})で都度取得したものを渡す想定）。
function computeGraduatedAmount(tiers, quantity) {
  if (!Array.isArray(tiers) || !(quantity > 0)) return 0;

  let remaining = quantity;
  let consumed = 0;
  let total = 0;

  for (const tier of tiers) {
    if (remaining <= 0) break;
    const upTo = tier.up_to === null || tier.up_to === undefined ? Infinity : tier.up_to;
    const tierCapacity = upTo - consumed;
    const used = Math.min(remaining, tierCapacity);
    if (used <= 0) continue;

    total += used * (tier.unit_amount || 0);
    if (tier.flat_amount) total += tier.flat_amount;

    consumed += used;
    remaining -= used;
  }

  return total;
}

module.exports = { computeGraduatedAmount };
