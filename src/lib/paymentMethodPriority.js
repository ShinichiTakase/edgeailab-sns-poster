// カードの優先度（primary/backup）を解決する共通ロジック。
// GET /api/billing/payment-methods（一覧表示）と invoice.payment_failed ウェブフック
// （バックアップカード探索）の両方から呼ぶ単一情報源とする。ロジックが分岐すると、
// 一覧画面に出ているカードと実際にリトライされるカードが食い違う事故につながるため、
// 判定ロジック自体は必ずここへ集約する。

// 既存有償顧客はStripe Checkout経由でカードを1枚だけ持ち、metadata.priorityが
// 一切設定されていない（Checkout完了時にStripeが自動でdefault_payment_methodに
// 設定するだけで、当時このメタデータの概念自体が存在しなかったため）。
// このカードは customer.invoice_settings.default_payment_method と一致していれば
// 暗黙のprimaryとして扱う（互換性フォールバック）。
function resolvePriorities(paymentMethods, defaultPaymentMethodId) {
  return paymentMethods.map((pm) => {
    const explicit = pm.metadata && pm.metadata.priority;
    if (explicit === "primary" || explicit === "backup") {
      return { paymentMethod: pm, priority: explicit, isLegacyDefault: false };
    }
    if (pm.id === defaultPaymentMethodId) {
      return { paymentMethod: pm, priority: "primary", isLegacyDefault: true };
    }
    // 通常発生しない想定（2枚目以降は必ずconfirmエンドポイントでpriorityを付与するため）。
    // 万一メタデータ欠損のカードが残っていた場合はbackup扱いとする（primaryを二重に
    // 扱わないためのフェイルセーフ）。
    return { paymentMethod: pm, priority: "backup", isLegacyDefault: false };
  });
}

function findPrimary(resolved) {
  return resolved.find((r) => r.priority === "primary") || null;
}

function findBackup(resolved) {
  return resolved.find((r) => r.priority === "backup") || null;
}

module.exports = { resolvePriorities, findPrimary, findBackup };
