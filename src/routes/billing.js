const express = require("express");
const customerStore = require("../lib/customerStore");
const { requireAuth } = require("../middleware/requireAuth");
const { getXSurcharge } = require("../lib/surchargeConfig");
const { getStripe } = require("../lib/stripeClient");
const { planKey, pricesForPlan } = require("../lib/stripePricing");

const router = express.Router();

// Basic→Standard→Advancedの順のみ許可（逆順=ダウングレードは不可）
const PLAN_ORDER = ["basic", "standard", "advanced"];

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

// プラン変更（アップグレードのみ）。認証済みセッションのcustomer自身が対象であり、
// リクエストボディでcustomerIdを受け取ることはない（=なりすまし変更は構造上不可能）。
router.post("/api/billing/change-plan", requireAuth, express.json(), async (req, res) => {
  const { targetPlan } = req.body || {};
  if (!PLAN_ORDER.includes(targetPlan)) {
    return res.status(400).json({ error: "invalid_target_plan", message: "指定されたプランが不正です。" });
  }

  const currentPlan = planKey(req.customer);
  const currentIndex = PLAN_ORDER.indexOf(currentPlan);
  if (currentIndex === -1) {
    console.error(
      `[billing/change-plan] customer has invalid current plan customerId=${req.customer.id} plan=${JSON.stringify(req.customer.plan)}`
    );
    return res.status(400).json({ error: "invalid_current_plan", message: "現在のプラン情報を確認できませんでした。" });
  }

  const targetIndex = PLAN_ORDER.indexOf(targetPlan);
  if (targetIndex <= currentIndex) {
    // サーバー側でも再検証する（クライアント側のUI制御=disabledボタンは信用しない）
    return res.status(400).json({
      error: "downgrade_not_allowed",
      message: "プランのダウングレードには対応していません。",
    });
  }

  const targetPrices = pricesForPlan(targetPlan);
  if (!targetPrices || !targetPrices.base || !targetPrices.metered || !targetPrices.meteredX) {
    console.error(`[billing/change-plan] price not configured for plan=${targetPlan}`);
    return res.status(500).json({ error: "plan_not_configured", message: "プラン変更に失敗しました。しばらくしてから再度お試しください。" });
  }

  // トライアル中（Checkout未完了）はStripeサブスクリプションが存在しないため、
  // microCMSのplanのみ更新する。実際のPrice選択は次回Checkout完了時にpricesForPlan()が
  // 更新後のplanを参照することで自動的に反映される。
  if (req.customer.stripeSubscriptionId) {
    const stripe = getStripe();
    if (!stripe) {
      return res.status(500).json({ error: "stripe_not_configured", message: "プラン変更に失敗しました。しばらくしてから再度お試しください。" });
    }

    let subscription;
    try {
      subscription = await stripe.subscriptions.retrieve(req.customer.stripeSubscriptionId);
    } catch (err) {
      console.error(
        `[billing/change-plan] failed to retrieve subscription customerId=${req.customer.id} subscriptionId=${req.customer.stripeSubscriptionId}:`,
        err
      );
      return res.status(500).json({ error: "stripe_error", message: "プラン変更に失敗しました。しばらくしてから再度お試しください。" });
    }

    const currentPrices = pricesForPlan(currentPlan) || {};
    const items = subscription.items.data
      .map((item) => {
        if (item.price.id === currentPrices.base) return { id: item.id, price: targetPrices.base };
        if (item.price.id === currentPrices.metered) return { id: item.id, price: targetPrices.metered };
        if (item.price.id === currentPrices.meteredX) return { id: item.id, price: targetPrices.meteredX };
        return null;
      })
      .filter(Boolean);

    if (items.length !== 3) {
      console.error(
        `[billing/change-plan] subscription items did not match current plan prices customerId=${req.customer.id} subscriptionId=${subscription.id} matched=${items.length}`
      );
      return res.status(500).json({ error: "subscription_items_mismatch", message: "プラン変更に失敗しました。しばらくしてから再度お試しください。" });
    }

    try {
      // proration_behavior: "none" により日割り調整は一切行わない。
      // 変更は即時反映されるが、請求は次回の通常のサブスクリプション更新時に
      // その時点のitems（=新プラン）の金額で行われる（このリクエスト内では課金しない）。
      await stripe.subscriptions.update(subscription.id, {
        items,
        proration_behavior: "none",
      });
    } catch (err) {
      console.error(
        `[billing/change-plan] Stripe subscription update failed customerId=${req.customer.id} subscriptionId=${subscription.id} from=${currentPlan} to=${targetPlan}:`,
        err
      );
      return res.status(500).json({ error: "stripe_error", message: "プラン変更に失敗しました。しばらくしてから再度お試しください。" });
    }
  }

  // Stripe側の更新（存在する場合）が成功した後にmicroCMSを更新する。
  // ここで失敗してもStripe側は既に新プランで確定しているため変更を取り消さない。
  try {
    await customerStore.updateCustomer(req.customer.id, {
      plan: [customerStore.toPlanChoice(targetPlan)],
    });
  } catch (err) {
    console.error(
      `[billing/change-plan] microCMS update failed after Stripe already updated customerId=${req.customer.id} subscriptionId=${req.customer.stripeSubscriptionId || "none"} from=${currentPlan} to=${targetPlan}:`,
      err
    );
    return res.status(200).json({
      ok: false,
      error: "reflection_delayed",
      message: "決済は完了しましたが反映に時間がかかっています。しばらくして再度ご確認ください。",
    });
  }

  console.info(`[billing/change-plan] changed plan customerId=${req.customer.id} from=${currentPlan} to=${targetPlan}`);
  res.json({ ok: true });
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
          stripeSubscriptionId: session.subscription,
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
