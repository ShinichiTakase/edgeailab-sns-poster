const express = require("express");
const customerStore = require("../lib/customerStore");
const { requireAuth } = require("../middleware/requireAuth");
const { getXSurcharge } = require("../lib/surchargeConfig");
const { getStripe } = require("../lib/stripeClient");
const { planKey, pricesForPlan } = require("../lib/stripePricing");

const router = express.Router();

// pricing.html・dashboard.htmlが表示用に参照する公開エンドポイント。
// 個人情報を含まないため認証不要。
router.get("/api/billing/x-surcharge", (req, res) => {
  try {
    res.json(getXSurcharge());
  } catch (err) {
    console.error("[billing/x-surcharge] failed to read config:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.post("/api/billing/create-checkout-session", requireAuth, express.json(), async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: "stripe_not_configured" });
  }

  const prices = pricesForPlan(planKey(req.customer));
  if (!prices || !prices.base || !prices.metered || !prices.meteredX) {
    console.error(`[billing/create-checkout-session] price not configured for plan=${JSON.stringify(req.customer.plan)}`);
    return res.status(500).json({ error: "plan_not_configured" });
  }

  const base = process.env.APP_BASE_URL || "https://edgeailab.net";

  try {
    let stripeCustomerId = req.customer.stripeCustomerId;
    if (!stripeCustomerId) {
      const stripeCustomer = await stripe.customers.create({ email: req.customer.email });
      stripeCustomerId = stripeCustomer.id;
      await customerStore.updateCustomer(req.customer.id, { stripeCustomerId });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      client_reference_id: req.customer.id,
      line_items: [
        { price: prices.base, quantity: 1 },
        { price: prices.metered },
        { price: prices.meteredX },
      ],
      success_url: `${base}/dashboard.html?billing=success`,
      cancel_url: `${base}/upgrade.html?billing=cancelled`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("[billing/create-checkout-session] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Stripe Webhookは署名検証のため生ボディが必要なので、このルートだけ
// express.json()ではなくexpress.raw()をミドルウェアとして適用する。
router.post("/api/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !webhookSecret) {
    console.error("[billing/webhook] Stripe or webhook secret not configured");
    return res.status(500).send("not configured");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], webhookSecret);
  } catch (err) {
    console.error("[billing/webhook] signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const customerId = session.client_reference_id;
      if (customerId) {
        await customerStore.updateCustomer(customerId, {
          stripeCustomerId: session.customer,
          stripeSubscription: session.subscription,
          status: ["active"],
        });
        console.info(`[billing/webhook] activated subscription for customer id=${customerId}`);
      } else {
        console.warn("[billing/webhook] checkout.session.completed without client_reference_id");
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error("[billing/webhook] handling failed:", err);
    res.status(500).send("internal error");
  }
});

module.exports = router;
