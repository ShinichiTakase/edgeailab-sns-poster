// 管理者ダッシュボード「Xサーチャージ」で予約された金額変更を、予約日（Asia/Tokyo）に
// 到達したら実際に適用する。cronから毎日実行し、予約が無い/未到達/適用済みの間は
// 何もしない（idempotent）。
//
// addXSurchargePriceItems.jsと同じ安全策として、デフォルトはdry-run。
//   node src/scripts/xSurchargeScheduleApply.js          → 何が起きるかのログのみ（実際には変更しない）
//   node src/scripts/xSurchargeScheduleApply.js --apply  → 実際にStripe価格・全顧客のサブスクリプションを変更
// crontab登録時は --apply を付ける（/etc/cron.d/edgeailab-net-x-surcharge-schedule-apply参照）。
//
// 処理内容（--apply時）:
//   1. plan（basic/standard/advanced）ごとに、現在のmeteredX Priceのproduct IDを取得し、
//      同じproductに新しいunit_amountのPriceを新規作成する
//      （Stripe PriceはImmutableなため、金額変更＝新規Price作成＋差し替えでしか実現できない）。
//      1つでも作成に失敗したら、他のプランも含め一切の変更を行わず中断する（部分適用を避ける）。
//   2. stripeSubscriptionIdを持つ解約済みでない全顧客について、対象プランの現在の
//      meteredX Priceが付いているsubscription itemを新しいPriceに差し替える
//      （proration_behavior: "none"＝日割り課金しない。差し替え以降の投稿分から新料金）。
//      顧客ごとの失敗は他顧客の処理を止めず、最後にまとめて報告する。
//   3. json/x_surcharge_current.json（xSurchargeStore.js）に新しい金額・Price IDを保存する。
//      以降pricesForPlan()がこちらを返すようになり、新規契約者にも新料金が適用される。
//   4. 予約を消化済みにする（削除）。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { getStripe } = require("../lib/stripeClient");
const { listAllCustomers, isCanceled } = require("../lib/customerStore");
const { planKey, pricesForPlan } = require("../lib/stripePricing");
const xSurchargeStore = require("../lib/xSurchargeStore");
const { notifyFailure } = require("../lib/mailer");
const { logInfo, logWarn, logError } = require("../lib/logger").createLogger("x-surcharge-schedule-apply.log");

const APPLY = process.argv.includes("--apply");
const PLANS = ["basic", "standard", "advanced"];

function todayJst() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

async function main() {
  const reservation = xSurchargeStore.getReservation();
  if (!reservation) {
    logInfo("[x-surcharge-schedule-apply] no reservation, nothing to do");
    return;
  }
  const today = todayJst();
  if (reservation.effectiveDate > today) {
    logInfo(
      `[x-surcharge-schedule-apply] reservation effectiveDate=${reservation.effectiveDate} not yet reached (today=${today})`
    );
    return;
  }

  const stripe = getStripe();
  if (!stripe) {
    logError("[x-surcharge-schedule-apply] stripe not configured");
    process.exit(1);
  }

  logInfo(
    `[x-surcharge-schedule-apply] ${APPLY ? "APPLY" : "DRY-RUN"} applying amountJpy=${reservation.amountJpy} effectiveDate=${reservation.effectiveDate}`
  );

  // 1. 現在のPrice（プランごと）を確認し、そのproductへ新Priceを作る。
  const oldPrices = {};
  for (const plan of PLANS) {
    const prices = pricesForPlan(plan);
    if (!prices || !prices.meteredX) {
      logError(`[x-surcharge-schedule-apply] plan=${plan} has no meteredX price configured; aborting`);
      process.exit(1);
    }
    oldPrices[plan] = prices.meteredX;
  }

  let oldPriceObjects;
  try {
    oldPriceObjects = await Promise.all(PLANS.map((plan) => stripe.prices.retrieve(oldPrices[plan])));
  } catch (err) {
    logError("[x-surcharge-schedule-apply] failed to retrieve current prices; aborting:", err);
    process.exit(1);
  }

  const newPriceIds = {};
  if (APPLY) {
    try {
      for (let i = 0; i < PLANS.length; i++) {
        const plan = PLANS[i];
        const product = oldPriceObjects[i].product;
        const newPrice = await stripe.prices.create({
          product,
          unit_amount: reservation.amountJpy,
          currency: "jpy",
          billing_scheme: "per_unit",
        });
        newPriceIds[plan] = newPrice.id;
        logInfo(`[x-surcharge-schedule-apply] plan=${plan} created new price=${newPrice.id} (old=${oldPrices[plan]})`);
      }
    } catch (err) {
      logError("[x-surcharge-schedule-apply] failed to create new prices; aborting without touching any subscription:", err);
      await notifyFailure(
        "【EdgeAI Lab】Xサーチャージ変更バッチ: 失敗（Price作成）",
        `予約されたXサーチャージ変更（${reservation.amountJpy}円、${reservation.effectiveDate}）の適用に失敗しました。\n` +
          `新しいStripe Priceの作成でエラーが発生したため、既存の課金設定には一切手を加えていません。\n\n` +
          `エラー: ${err.message}`
      );
      process.exit(1);
    }
  } else {
    for (const plan of PLANS) newPriceIds[plan] = "(dry-run: 未作成)";
  }

  // 2. 全顧客のsubscription itemを差し替える。
  const customers = await listAllCustomers();
  const targets = customers.filter((c) => c.stripeSubscriptionId && !isCanceled(c));
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const failedCustomerIds = [];

  for (const customer of targets) {
    const plan = planKey(customer);
    if (!PLANS.includes(plan)) {
      logWarn(`[x-surcharge-schedule-apply] id=${customer.id} has unknown plan=${JSON.stringify(customer.plan)}, skipping`);
      skipped++;
      continue;
    }
    try {
      const items = await stripe.subscriptionItems.list({ subscription: customer.stripeSubscriptionId });
      const item = items.data.find((i) => i.price.id === oldPrices[plan]);
      if (!item) {
        logWarn(`[x-surcharge-schedule-apply] id=${customer.id} plan=${plan} has no matching X surcharge subscription item, skipping`);
        skipped++;
        continue;
      }
      logInfo(
        `[x-surcharge-schedule-apply] id=${customer.id} plan=${plan} item=${item.id} ${APPLY ? "swapping" : "would swap (dry-run)"} price ${oldPrices[plan]} -> ${newPriceIds[plan]}`
      );
      if (APPLY) {
        await stripe.subscriptionItems.update(item.id, { price: newPriceIds[plan], proration_behavior: "none" });
      }
      updated++;
    } catch (err) {
      logError(`[x-surcharge-schedule-apply] id=${customer.id} plan=${plan} failed:`, err);
      failed++;
      failedCustomerIds.push(customer.id);
    }
  }

  logInfo(`[x-surcharge-schedule-apply] done. updated=${updated} skipped=${skipped} failed=${failed}`);

  if (APPLY) {
    xSurchargeStore.setCurrent({ amountJpy: reservation.amountJpy, priceIds: newPriceIds });
    xSurchargeStore.clearReservation();
    logInfo("[x-surcharge-schedule-apply] cached new current amount/price ids, reservation cleared");

    if (failed > 0) {
      await notifyFailure(
        "【EdgeAI Lab】Xサーチャージ変更バッチ: 一部の顧客で失敗",
        `Xサーチャージを${reservation.amountJpy}円に変更しました（新Price作成済み・設定も更新済み）が、` +
          `以下の顧客のサブスクリプション更新に失敗しました。Stripeダッシュボードで手動確認・対応してください。\n\n` +
          `customerId: ${failedCustomerIds.join(", ")}`
      );
    }
  }
}

main().catch((err) => {
  logError("[x-surcharge-schedule-apply] fatal error:", err);
  process.exit(1);
});
