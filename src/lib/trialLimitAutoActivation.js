// トライアル投稿上限（60通）到達時、既に支払い方法（Stripeカード）を登録済みの
// トライアル顧客を即座に本稼働（status:"active"）へ切り替え、基本料金の即時請求を
// 開始する（2026-08-25追加）。posts.js（即時投稿・ワンショット予約投稿）・
// scheduledPostExecutor.js（継続スケジュール投稿）の3箇所すべてから、
// bumpTrialPostCount実行後にcustomerStore.crossedTrialPostLimitで「今回の加算で
// 初めて60通ラインを跨いだか」を判定してから呼ばれる想定（trialPostLimitWarningMailer.js
// の80%到達時即時メールと対になる仕組み）。
//
// 支払い方法が未登録の場合は何もしない（requireUnderTrialPostLimit等の既存の
// ブロックがそのまま効き、投稿は停止したままになる）。
const { getStripe, ensureStripeCustomer } = require("./stripeClient");
const { pricesForPlan, planKey } = require("./stripePricing");
const { updateCustomer } = require("./customerStore");
const { customerHasPaymentMethod } = require("./trialPostLimitWarningMailer");

/**
 * @param {object} params
 * @param {object} params.customer customersの1レコード
 * @param {{logError: Function}} [params.logger]
 * @returns {Promise<"activated"|"no_payment_method"|"failed">}
 */
async function activateAfterTrialLimitIfNeeded({ customer, logger }) {
  try {
    const hasPaymentMethod = await customerHasPaymentMethod(customer.stripeCustomerId);
    if (!hasPaymentMethod) return "no_payment_method";

    const stripe = getStripe();
    if (!stripe) return "failed";

    const prices = pricesForPlan(planKey(customer));
    if (!prices || !prices.base || !prices.metered || !prices.meteredX) {
      if (logger) {
        logger.logError(
          `[trialLimitAutoActivation] price not configured for plan=${JSON.stringify(customer.plan)} customerId=${customer.id}`
        );
      }
      return "failed";
    }

    const stripeCustomerId = await ensureStripeCustomer(stripe, customer);

    // create-checkout-session（billing.js）とは異なり、意図的にtrial_endを指定しない
    // ＝作成と同時に最初のinvoiceが生成・確定され、Stripe顧客のdefault_payment_method
    // （billing.jsのpayment-methods/confirmで登録済みのはず）へ自動的に請求される。
    // 「60通到達＝支払い方法登録済みなら即時課金」という仕様のため。
    const subscription = await stripe.subscriptions.create({
      customer: stripeCustomerId,
      items: [{ price: prices.base }, { price: prices.metered }, { price: prices.meteredX }],
    });

    if (subscription.status !== "active") {
      // カード自体は登録されているが、作成直後の決済が何らかの理由で失敗した場合
      // （残高不足・カード拒否等でsubscription.statusがincompleteになるケース）。
      // 誤って本稼働扱いにしないよう、customerのstatusは更新しない
      // （＝トライアル扱いのまま投稿ブロックが継続する）。
      if (logger) {
        logger.logError(
          `[trialLimitAutoActivation] subscription not active after creation customerId=${customer.id} subscriptionId=${subscription.id} status=${subscription.status}`
        );
      }
      return "failed";
    }

    await updateCustomer(customer.id, {
      stripeSubscriptionId: subscription.id,
      status: ["active"],
      trialLimitAutoActivatedAt: new Date().toISOString(),
    });
    return "activated";
  } catch (err) {
    if (logger) logger.logError(`[trialLimitAutoActivation] failed customerId=${customer.id}:`, err);
    return "failed";
  }
}

module.exports = { activateAfterTrialLimitIfNeeded };
