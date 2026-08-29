// Stripeクライアントの初期化を一元化する。billing.js・メーターイベント送信・
// 各種スクリプトから共通で参照する。
const Stripe = require("stripe");
const customerStore = require("./customerStore");
const { invoiceRenderingTemplateForPlan } = require("./stripePricing");

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}

// 顧客にStripe CustomerIDが未設定なら作成し、customerStore側にも保存する。
// billing.jsのcreate-checkout-sessionと、お支払い方法のsetup-intentエンドポイントの
// 両方から使う（元はcreate-checkout-session内にインラインで実装されていたロジック）。
async function ensureStripeCustomer(stripe, customer) {
  if (customer.stripeCustomerId) return customer.stripeCustomerId;
  const stripeCustomer = await stripe.customers.create({ email: customer.email });
  await customerStore.updateCustomer(customer.id, { stripeCustomerId: stripeCustomer.id });
  return stripeCustomer.id;
}

// 顧客のStripe Customerに、プランに対応するInvoice Rendering Templateを設定する。
// 新規サブスクリプション加入時・プラン変更時の両方から呼ぶ（呼ぶたびに新プランの
// テンプレートIDへ上書きされるため、古いプランのテンプレートIDが残ることはない）。
// 対応するテンプレートIDが.envに未設定のプランの場合は何もしない（段階導入を許容する）。
async function applyInvoiceRenderingTemplate(stripe, stripeCustomerId, plan) {
  const templateId = invoiceRenderingTemplateForPlan(plan);
  if (!templateId) return;
  await stripe.customers.update(stripeCustomerId, {
    invoice_settings: { rendering_options: { template: templateId } },
  });
}

module.exports = { getStripe, ensureStripeCustomer, applyInvoiceRenderingTemplate };
