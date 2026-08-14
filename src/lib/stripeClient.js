// Stripeクライアントの初期化を一元化する。billing.js・メーターイベント送信・
// 各種スクリプトから共通で参照する。
const Stripe = require("stripe");

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}

module.exports = { getStripe };
