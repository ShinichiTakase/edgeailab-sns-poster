// Stripeの確定済みinvoiceを、請求情報一覧・PDF領収書の両方が使う構造化データに変換する。
// 一覧APIとPDF生成の両方から共有し、表示ロジックの二重実装を避ける。
const { classifyPriceId } = require("./stripePricing");
const { listPostingLogsForCustomer } = require("./postingLogStore");

const PLATFORM_LABELS = { x: "X", threads: "Threads", facebook: "Facebook", instagram: "Instagram" };

// invoice line item の period（Unixタイムスタンプ）から、posting_logsのbilling_period形式
// （"YYYY-MM"）を導出する。period.end はその期間の終了時刻（翌月1日0時であることが多い）
// のため、1秒引いてから月を判定する。
function derivePeriodKey(line) {
  const periodEnd = line.period && line.period.end;
  if (!periodEnd) return null;
  const d = new Date((periodEnd - 1) * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * @param {import('stripe').Stripe.Invoice} invoice 確定済み（status: paid/open等）のStripe invoice
 * @param {string} customerCode microCMS顧客id（posting_logs.customer_codeと一致する値）
 */
async function buildInvoiceSummary(invoice, customerCode) {
  const base = { quantity: 0, unitAmount: 0, amount: 0 };
  let planLabel = null;
  let usageTotalAmount = 0;
  let usageBillingPeriod = null;
  let usageQuantityFromStripe = 0;
  let xSurchargeAmount = 0;
  let xSurchargeCount = 0;
  let unclassifiedAmount = 0;

  for (const line of invoice.lines.data) {
    const priceId = line.price && line.price.id;
    const classification = priceId ? classifyPriceId(priceId) : null;
    if (!classification) {
      unclassifiedAmount += line.amount;
      continue;
    }
    if (classification.category === "base") {
      base.quantity += line.quantity || 1;
      base.unitAmount = (line.price && line.price.unit_amount) || 0;
      base.amount += line.amount;
      planLabel = classification.planLabel;
    } else if (classification.category === "metered") {
      usageTotalAmount += line.amount;
      usageQuantityFromStripe += line.quantity || 0;
      if (!usageBillingPeriod) usageBillingPeriod = derivePeriodKey(line);
    } else if (classification.category === "meteredX") {
      xSurchargeAmount += line.amount;
      xSurchargeCount += line.quantity || 0;
    }
  }

  // ③従量料金1: プラットフォーム別の投稿数はposting_logs（実際に投稿された記録）から取得する。
  // Stripeの従量課金は全プラットフォーム合算の単一カウンターのため、プラットフォームごとの
  // 「単価」は実在せず（段階制料金のため）、実際の課金額を全体投稿数で割った「平均単価」を
  // 各行に按分する。最終行で端数を吸収し、行の合計金額が必ずusageTotalAmount（Stripeの
  // 実請求額）と一致するようにする。
  const usageLines = [];
  if (usageBillingPeriod && usageTotalAmount > 0) {
    const logs = await listPostingLogsForCustomer(customerCode, usageBillingPeriod);
    const countsByPlatform = {};
    for (const log of logs) {
      const platform = Array.isArray(log.platform) ? log.platform[0] : log.platform;
      if (!platform) continue;
      countsByPlatform[platform] = (countsByPlatform[platform] || 0) + 1;
    }
    const entries = Object.entries(countsByPlatform);
    const totalCount = entries.reduce((sum, [, count]) => sum + count, 0);

    if (totalCount > 0) {
      const averageUnitPrice = usageTotalAmount / totalCount;
      let allocated = 0;
      entries.forEach(([platform, count], idx) => {
        const isLast = idx === entries.length - 1;
        const amount = isLast ? usageTotalAmount - allocated : Math.round(averageUnitPrice * count);
        allocated += amount;
        usageLines.push({
          platform: PLATFORM_LABELS[platform] || platform,
          count,
          averageUnitPrice: Math.round(averageUnitPrice),
          amount,
        });
      });
    } else {
      // posting_logsに記録が見つからない場合（過去データ欠損等）でも、Stripeの実請求額は
      // 表示から漏らさないよう「投稿記録」1行としてそのまま計上する。
      usageLines.push({
        platform: "投稿記録",
        count: usageQuantityFromStripe,
        averageUnitPrice: usageQuantityFromStripe > 0 ? Math.round(usageTotalAmount / usageQuantityFromStripe) : 0,
        amount: usageTotalAmount,
      });
    }
  }

  const subtotalExclusive = base.amount + usageTotalAmount + xSurchargeAmount + unclassifiedAmount;

  return {
    id: invoice.id,
    billedAt: invoice.status_transitions && invoice.status_transitions.finalized_at
      ? new Date(invoice.status_transitions.finalized_at * 1000).toISOString()
      : new Date(invoice.created * 1000).toISOString(),
    planLabel,
    baseFee: base,
    usageLines,
    xSurcharge: {
      count: xSurchargeCount,
      unitPrice: xSurchargeCount > 0 ? Math.round(xSurchargeAmount / xSurchargeCount) : 0,
      amount: xSurchargeAmount,
    },
    unclassifiedAmount,
    subtotalExclusive,
    // 消費税・請求額はStripe側の実確定値をそのまま使う（automatic_tax未有効時は0円、
    // 有効時はStripeが実際に計算した額と、常に1円単位で一致させるため）。
    // invoiceTax.computeConsumptionTax()は、automatic_tax有効時にこの値と一致するかの
    // 検証・将来の見積り機能で使う検算用ユーティリティという位置づけ。
    tax: invoice.tax || 0,
    total: invoice.total,
  };
}

module.exports = { buildInvoiceSummary };
