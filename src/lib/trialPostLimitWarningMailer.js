// トライアル投稿数が上限（TRIAL_POST_LIMIT）の80%に達した瞬間に、即時メール通知する。
// posts.js（即時投稿・ワンショット予約投稿）・scheduledPostExecutor.js（継続スケジュール
// 投稿）のいずれも、bumpTrialPostCount呼び出し後にcustomerStore.crossedTrialPostLimitWarning
// で「今回の加算で初めて80%を跨いだか」を判定してから、trueの場合のみここを呼ぶ想定
// （scheduleResultMailer.jsと同じ「呼び出し元でtry/catchし、送信失敗を投稿処理自体の
// 成否に影響させない」方針）。
//
// 2026-08-25変更: 支払い方法登録済みでも送信自体はスキップしない（以前は登録済みなら
// 送らない設計だった）。60通到達時、未登録なら投稿停止・登録済みなら登録済みカードへ
// 自動課金という仕様になったため（trialLimitAutoActivation.js参照）、このメールも
// 「あと少しで上限です。登録済みの方は自動課金されます／未登録の方は投稿が止まります」
// という案内を、登録状況に応じて出し分けて必ず送る。
const { getStripe } = require("./stripeClient");
const { sendCustomerMail } = require("./customerMailer");
const { TRIAL_POST_LIMIT_WARNING_EMAIL } = require("./emailTemplates");
const { TRIAL_POST_LIMIT } = require("./customerStore");

// トライアル中に支払い方法（Stripeカード）を登録済みかどうか。customer.status・
// stripeSubscriptionIdでは判定できない点に注意: billing.jsのpayment-methods/confirm
// （カード登録のみ）はサブスクリプションを作成せず、customer.statusを"trial"のまま
// 維持する設計のため、実際にStripe側のカード登録状況を都度確認する必要がある。
async function customerHasPaymentMethod(stripeCustomerId) {
  if (!stripeCustomerId) return false;
  const stripe = getStripe();
  if (!stripe) return false;
  const pms = await stripe.paymentMethods.list({ customer: stripeCustomerId, type: "card" });
  return pms.data.length > 0;
}

/**
 * @param {object} params
 * @param {object} params.customer customersの1レコード（email, stripeCustomerId, plan等を使う）
 * @param {{logError: Function}} [params.logger]
 * @returns {Promise<boolean>} 実際に送信できたか
 */
async function sendTrialPostLimitWarningIfNeeded({ customer, logger }) {
  try {
    const hasPaymentMethod = await customerHasPaymentMethod(customer.stripeCustomerId);

    // 未登録の場合のみpayment.htmlへの登録導線を案内する（登録済みの場合は
    // 「自動課金される」旨のみで、リンクは不要）。トライアル中にpayment.html経由で
    // カードだけ先に登録しておけば、実際に60通へ到達した瞬間
    // trialLimitAutoActivation.jsが自動でサブスクリプションを作成し即時課金する
    // ため、このリンク先はpayment.htmlで正しい（upgrade.html等の手動Checkoutを
    // 経由する必要はない）。
    const base = process.env.APP_BASE_URL || "https://edgeailab.net";
    const paymentUrl = `${base}/payment.html`;
    const planValue = Array.isArray(customer.plan) ? customer.plan[0] : customer.plan;
    const planForLabel = typeof planValue === "string" ? planValue.toLowerCase() : planValue;

    const result = await sendCustomerMail({
      toEmail: customer.email,
      subject: TRIAL_POST_LIMIT_WARNING_EMAIL.subject,
      text: TRIAL_POST_LIMIT_WARNING_EMAIL.body(
        Number(customer.trialPostCount) || 0,
        TRIAL_POST_LIMIT,
        paymentUrl,
        planForLabel,
        hasPaymentMethod
      ),
    });
    return Boolean(result && result.ok);
  } catch (err) {
    if (logger) logger.logError(`[trialPostLimitWarningMailer] failed customerId=${customer.id}:`, err);
    return false;
  }
}

module.exports = { sendTrialPostLimitWarningIfNeeded, customerHasPaymentMethod };
