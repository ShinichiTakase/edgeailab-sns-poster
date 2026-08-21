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
  const initial = paymentMethods.map((pm) => {
    const explicit = pm.metadata && pm.metadata.priority;
    if (explicit === "primary" || explicit === "backup") {
      return { paymentMethod: pm, priority: explicit, isLegacyDefault: false };
    }
    if (pm.id === defaultPaymentMethodId) {
      return { paymentMethod: pm, priority: "primary", isLegacyDefault: true };
    }
    // 未確定（後段で判定する）
    return { paymentMethod: pm, priority: null, isLegacyDefault: false };
  });

  // 明示metadataでも default_payment_method 一致でもprimaryが1件も定まらなかった場合
  // （= default_payment_method自体が未設定/既に存在しないカードを指している「完全に古い」
  // 顧客）。この状態でカードが1枚以上あるなら、先頭の1枚を暗黙のprimaryとして扱う
  // （そうしないと、そのカードは永久にbackup扱いのまま自己修復もされずUIにprimaryが
  // 一つも表示されなくなるため）。
  if (!initial.some((r) => r.priority === "primary")) {
    const first = initial.find((r) => r.priority === null);
    if (first) {
      first.priority = "primary";
      first.isLegacyDefault = true;
    }
  }

  // 残った未確定は全てbackup扱いにする（通常はconfirmエンドポイントが必ずpriorityを
  // 付与するため発生しない想定。メタデータ欠損時のフェイルセーフ）。
  return initial.map((r) => (r.priority === null ? { ...r, priority: "backup" } : r));
}

function findPrimary(resolved) {
  return resolved.find((r) => r.priority === "primary") || null;
}

function findBackup(resolved) {
  return resolved.find((r) => r.priority === "backup") || null;
}

module.exports = { resolvePriorities, findPrimary, findBackup };
