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
const { updateCustomer, TRIAL_POST_LIMIT } = require("./customerStore");
const { customerHasPaymentMethod } = require("./trialPostLimitWarningMailer");
const { sendCustomerMail } = require("./customerMailer");
const { TRIAL_POST_LIMIT_REACHED_EMAIL } = require("./emailTemplates");

const ACTIVATION_METADATA_KEY = "edgeailab_trial_activation_key";

function activationKeyFor(customer) {
  // 1顧客につき無料トライアルは1回だけという既存仕様を業務キーにする。
  // customer.idはmicroCMSの不変IDなので、プロセス再起動後も同じキーになる。
  return `trial-limit:${customer.id}`;
}

async function findExistingActivationSubscription(stripe, stripeCustomerId, activationKey) {
  const page = await stripe.subscriptions.list({
    customer: stripeCustomerId,
    status: "all",
    limit: 100,
  });
  return (page.data || []).find(
    (subscription) => subscription.metadata?.[ACTIVATION_METADATA_KEY] === activationKey
  ) || null;
}

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

    const activationKey = activationKeyFor(customer);
    // StripeのIdempotency-Key保持期間（24時間以上）を越えてDB保存だけが再試行
    // された場合にも、前回作成済みの契約をmetadataから回収する。
    let subscription = await findExistingActivationSubscription(stripe, stripeCustomerId, activationKey);

    // create-checkout-session（billing.js）とは異なり、意図的にtrial_endを指定しない
    // ＝作成と同時に最初のinvoiceが生成・確定され、Stripe顧客のdefault_payment_method
    // （billing.jsのpayment-methods/confirmで登録済みのはず）へ自動的に請求される。
    // 「60通到達＝支払い方法登録済みなら即時課金」という仕様のため。
    if (!subscription) {
      subscription = await stripe.subscriptions.create(
        {
          customer: stripeCustomerId,
          items: [{ price: prices.base }, { price: prices.metered }, { price: prices.meteredX }],
          metadata: { [ACTIVATION_METADATA_KEY]: activationKey },
          // Checkout経由と同じ設定済み税率を、自動本契約化にも適用する。
          ...(process.env.STRIPE_TAX_RATE_ID
            ? { default_tax_rates: [process.env.STRIPE_TAX_RATE_ID] }
            : {}),
        },
        // 同時実行・通信断・短時間の再試行ではStripe自身に同一リクエストとして
        // 扱わせる。metadata照合と併用し、24時間を越えるDB再試行もカバーする。
        { idempotencyKey: activationKey }
      );
    }

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

/**
 * 投稿上限（60通）到達を通知するメールを送る（2026-08-25追加）。
 * activateAfterTrialLimitIfNeededの結果（"activated"|"no_payment_method"|"failed"）に
 * 応じて件名・本文を出し分ける。"failed"（カード自体はあるが決済失敗等）の場合は
 * 状態が中途半端なため、誤った案内をしないよう送信しない。
 * @param {object} params
 * @param {object} params.customer
 * @param {"activated"|"no_payment_method"|"failed"} params.result
 * @param {{logError: Function}} [params.logger]
 * @returns {Promise<boolean>}
 */
async function sendTrialPostLimitReachedEmailIfNeeded({ customer, result, logger }) {
  if (result !== "activated" && result !== "no_payment_method") return false;
  try {
    const activated = result === "activated";
    const base = process.env.APP_BASE_URL || "https://edgeailab.net";
    const paymentUrl = `${base}/payment.html`;
    const planValue = Array.isArray(customer.plan) ? customer.plan[0] : customer.plan;
    const planForLabel = typeof planValue === "string" ? planValue.toLowerCase() : planValue;

    const mailResult = await sendCustomerMail({
      toEmail: customer.email,
      subject: TRIAL_POST_LIMIT_REACHED_EMAIL.subject(activated),
      text: TRIAL_POST_LIMIT_REACHED_EMAIL.body(TRIAL_POST_LIMIT, paymentUrl, planForLabel, activated),
    });
    return Boolean(mailResult && mailResult.ok);
  } catch (err) {
    if (logger) logger.logError(`[trialLimitAutoActivation] reached email failed customerId=${customer.id}:`, err);
    return false;
  }
}

module.exports = { activateAfterTrialLimitIfNeeded, sendTrialPostLimitReachedEmailIfNeeded };
