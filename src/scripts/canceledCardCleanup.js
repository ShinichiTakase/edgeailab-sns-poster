// 解約から23:30（23時間30分）経過した顧客のStripeカード情報を削除するcron。
// 他のscripts/*.jsと同じ単発実行スクリプトで、cronから
// `docker compose run --rm sns-poster-canceled-card-cleanup` で毎時起動する想定
// （実際のcrontab登録は手動実施。CLAUDE.md参照）。
//
// 以前はaccount.js（解約API）内でStripeサブスクリプション解約と同時にカードもdetach
// していたが、2026-09-02に「解約と同時に最終請求書を決済する（invoice_now: true→
// finalizeInvoice→pay）」実装を追加したのに合わせ、カード削除だけをこのcronへ遅延させた。
// 理由: 決済がその場で完了しない場合（Stripe側の一時的な失敗等）に備え、Stripeの
// 自動リトライが完了するだけの猶予を持たせつつ、24時間の再登録ロック
// （customerStore.isWithinCancellationLock、auth.js参照）が解ける直前にはカードが
// 無くなっている状態にするため23:30という値にしている。
//
// customer.canceledAtがmicroCMSスキーマ未対応で書き込めていない場合、
// customerStore.isPastCardDeletionDelayは常にfalseを返す（＝このcronは何もしない）。
// 2026-08-25に発生した「未定義フィールドのため判定が常に一方向に倒れて重複課金を招いた」
// 事故（trialLimitAutoActivatedAt、CLAUDE.md参照）の教訓を踏まえた安全側の設計。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { listAllCustomers, isCanceled, isPastCardDeletionDelay } = require("../lib/customerStore");
const { getStripe } = require("../lib/stripeClient");
const { notifyFailure } = require("../lib/mailer");
const { logInfo, logError } = require("../lib/logger").createLogger("canceled-card-cleanup.log");

async function main() {
  const stripe = getStripe();
  if (!stripe) {
    logError("[canceled-card-cleanup] Stripe not configured, skipping");
    return;
  }

  const customers = await listAllCustomers();
  const targets = customers.filter(
    (c) => isCanceled(c) && c.stripeCustomerId && isPastCardDeletionDelay(c)
  );
  logInfo(`[canceled-card-cleanup] ${targets.length} customer(s) to check (of ${customers.length} total)`);

  let deletedCardCount = 0;
  let processedCustomerCount = 0;

  for (const customer of targets) {
    try {
      const cards = await stripe.paymentMethods.list({ customer: customer.stripeCustomerId, type: "card" });
      if (cards.data.length === 0) continue;
      for (const pm of cards.data) {
        await stripe.paymentMethods.detach(pm.id);
        deletedCardCount += 1;
      }
      processedCustomerCount += 1;
      logInfo(
        `[canceled-card-cleanup] detached cards customerId=${customer.id} email=${customer.email} count=${cards.data.length}`
      );
    } catch (err) {
      logError(`[canceled-card-cleanup] failed customerId=${customer.id}:`, err);
      await notifyFailure(
        "[edgeailab] 解約後カード削除cronでエラー",
        [
          `customerId: ${customer.id}`,
          `email: ${customer.email}`,
          `stripeCustomerId: ${customer.stripeCustomerId}`,
          `エラー: ${err.message}`,
          "",
          "解約から23:30経過後のカード削除に失敗しました。Stripe管理画面で個別に",
          "カード情報を確認し、必要に応じて手動削除してください。",
        ].join("\n")
      ).catch(() => {});
    }
  }

  logInfo(
    `[canceled-card-cleanup] done. customers=${processedCustomerCount} cards=${deletedCardCount}`
  );
}

main().catch((err) => {
  logError("[canceled-card-cleanup] fatal error:", err);
  process.exit(1);
});
