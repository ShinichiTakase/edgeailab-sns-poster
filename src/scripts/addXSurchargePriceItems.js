// 既存契約customerのStripeサブスクリプションに、新設したXサーチャージPrice
// （sns_poster_posts用のitemとは別item）を追加するワンショットスクリプト。
// cron登録はせず、ユーザーが手動で実行する運用。デフォルトはdry-run。
//   node src/scripts/addXSurchargePriceItems.js          → 対象一覧の確認のみ（実際には追加しない）
//   node src/scripts/addXSurchargePriceItems.js --apply  → 実際にsubscription itemを追加
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const customerStore = require("../lib/customerStore");
const { getStripe } = require("../lib/stripeClient");
const { planKey, pricesForPlan } = require("../lib/stripePricing");

const APPLY = process.argv.includes("--apply");

async function main() {
  const stripe = getStripe();
  if (!stripe) {
    console.error("[x-surcharge-items] STRIPE_SECRET_KEYが未設定です");
    process.exit(1);
  }

  const customers = await customerStore.listAllCustomers();
  const targets = customers.filter((c) => c.stripeSubscriptionId && c.stripeCustomerId);

  console.info(
    `[x-surcharge-items] ${APPLY ? "APPLY" : "DRY-RUN"}モード。対象候補${targets.length}件（全customer${customers.length}件中）。`
  );

  let added = 0;
  let skipped = 0;
  let failed = 0;

  for (const customer of targets) {
    const plan = planKey(customer);
    const prices = pricesForPlan(plan);
    if (!prices || !prices.meteredX) {
      console.warn(`[x-surcharge-items] id=${customer.id} plan=${JSON.stringify(customer.plan)} のXサーチャージPriceが未設定のためスキップ`);
      failed++;
      continue;
    }

    let items;
    try {
      items = await stripe.subscriptionItems.list({ subscription: customer.stripeSubscriptionId });
    } catch (err) {
      console.error(`[x-surcharge-items] id=${customer.id} サブスクリプションitem取得失敗:`, err.message);
      failed++;
      continue;
    }

    if (items.data.some((item) => item.price.id === prices.meteredX)) {
      console.info(`[x-surcharge-items] id=${customer.id} には既にXサーチャージitemが存在するためスキップ`);
      skipped++;
      continue;
    }

    console.info(
      `[x-surcharge-items] id=${customer.id} plan=${plan} subscription=${customer.stripeSubscriptionId} にprice=${prices.meteredX} を追加${APPLY ? "します" : "する予定（dry-run）"}`
    );

    if (!APPLY) {
      added++;
      continue;
    }

    try {
      await stripe.subscriptionItems.create({
        subscription: customer.stripeSubscriptionId,
        price: prices.meteredX,
      });
      added++;
    } catch (err) {
      console.error(`[x-surcharge-items] id=${customer.id} item追加失敗:`, err.message);
      failed++;
    }
  }

  console.info(
    `[x-surcharge-items] 完了: 追加${APPLY ? "" : "予定"}=${added} スキップ=${skipped} 失敗=${failed}`
  );
}

main().catch((err) => {
  console.error("[x-surcharge-items] unexpected failure:", err);
  process.exit(1);
});
