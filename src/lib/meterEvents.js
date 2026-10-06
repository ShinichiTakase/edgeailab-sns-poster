// Stripe Billing Meterへのイベント送信。
// 新Meter(x surcharge)・既存Meter(sns_poster_posts)ともcustomer_mapping.type=by_id
// (event_payload_key="stripe_customer_id")、value_settings.event_payload_key="value"
// で設定されているため、payloadのキー名はこれに合わせる。
const { getStripe } = require("./stripeClient");

async function reportMeterEvent(eventName, stripeCustomerId, idempotencyKey) {
  const stripe = getStripe();
  if (!stripe || !stripeCustomerId) return;
  await stripe.billing.meterEvents.create({
    event_name: eventName,
    payload: {
      stripe_customer_id: stripeCustomerId,
      value: "1",
    },
  }, idempotencyKey ? { idempotencyKey } : undefined);
}

module.exports = { reportMeterEvent };
