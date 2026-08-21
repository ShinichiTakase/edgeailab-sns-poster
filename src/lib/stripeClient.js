// Stripeクライアントの初期化を一元化する。billing.js・メーターイベント送信・
// 各種スクリプトから共通で参照する。
const Stripe = require("stripe");
const customerStore = require("./customerStore");

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

module.exports = { getStripe, ensureStripeCustomer };
