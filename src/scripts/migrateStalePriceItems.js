// Stripe側でPriceオブジェクトを新規作成し直した（旧Priceをarchiveして新IDに切り替えた）際、
// 既存契約中のサブスクリプションitemは自動移行されないため、旧Priceを参照したまま残ってしまう
// （2026-08-28、Xサーチャージ用PriceをQ段階制(graduated)からper_unitへ切り替えた際に発生）。
// これを放置すると:
//   - /api/billing/change-plan のプラン変更が、現行Price IDとの突き合わせ不一致
//     （items.length !== 3）で失敗する
//   - ご請求予測（estimateBillingForecast）・請求情報一覧（classifyPriceId）が、旧Price IDを
//     認識できず、Xサーチャージを0円/未分類として扱ってしまう
// 全契約中customerを横断し、サブスクリプションitemの価格が現在のpricesForPlan()と食い違って
// いれば、該当item自体は残したまま価格だけ現在のPrice IDへ更新する
// （stripe.subscriptions.update({items:[{id, price}]}, proration_behavior:"none")。
// 日割り調整なし・即時反映）。
//
// 旧Price IDを直接ハードコードせず、「metered種別だが現在のmetered PriceでもmeteredX Price
// でもないitem」をズレたXサーチャージ itemとみなす方式にしているため、今後また同様の
// Priceローテーションが起きた場合も再実行できる。
//   node src/scripts/migrateStalePriceItems.js          → 対象一覧の確認のみ（dry-run）
//   node src/scripts/migrateStalePriceItems.js --apply  → 実際に更新
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const customerStore = require("../lib/customerStore");
const { getStripe } = require("../lib/stripeClient");
const { planKey, pricesForPlan } = require("../lib/stripePricing");

const APPLY = process.argv.includes("--apply");

async function main() {
  const stripe = getStripe();
  if (!stripe) {
    console.error("[migrate-stale-price-items] STRIPE_SECRET_KEYが未設定です");
    process.exit(1);
  }

  const customers = await customerStore.listAllCustomers();
  const targets = customers.filter((c) => c.stripeSubscriptionId);

  console.info(`[migrate-stale-price-items] ${APPLY ? "APPLY" : "DRY-RUN"}モード。対象候補${targets.length}件（全customer${customers.length}件中）。`);

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const customer of targets) {
    const plan = planKey(customer);
    const prices = pricesForPlan(plan);
    if (!prices || !prices.base || !prices.metered || !prices.meteredX) {
      console.warn(`[migrate-stale-price-items] id=${customer.id} plan=${JSON.stringify(customer.plan)} のPriceが未設定のためスキップ`);
      failed++;
      continue;
    }

    let subscription;
    try {
      subscription = await stripe.subscriptions.retrieve(customer.stripeSubscriptionId, { expand: ["items.data.price"] });
    } catch (err) {
      console.error(`[migrate-stale-price-items] id=${customer.id} サブスクリプション取得失敗:`, err.message);
      failed++;
      continue;
    }

    const staleItem = subscription.items.data.find((item) => {
      const price = item.price;
      const isMetered = price.recurring && price.recurring.usage_type === "metered";
      return isMetered && price.id !== prices.metered && price.id !== prices.meteredX;
    });

    if (!staleItem) {
      skipped++;
      continue;
    }

    console.info(
      `[migrate-stale-price-items] id=${customer.id} plan=${plan} subscription=${customer.stripeSubscriptionId} ` +
        `item=${staleItem.id} price ${staleItem.price.id} → ${prices.meteredX} に${APPLY ? "更新します" : "更新する予定（dry-run）"}`
    );

    if (!APPLY) {
      migrated++;
      continue;
    }

    try {
      await stripe.subscriptions.update(customer.stripeSubscriptionId, {
        items: [{ id: staleItem.id, price: prices.meteredX }],
        proration_behavior: "none",
      });
      migrated++;
    } catch (err) {
      console.error(`[migrate-stale-price-items] id=${customer.id} item更新失敗:`, err.message);
      failed++;
    }
  }

  console.info(
    `[migrate-stale-price-items] 完了: 更新${APPLY ? "" : "予定"}=${migrated} スキップ(対象外)=${skipped} 失敗=${failed}`
  );
}

main().catch((err) => {
  console.error("[migrate-stale-price-items] unexpected failure:", err);
  process.exit(1);
});
