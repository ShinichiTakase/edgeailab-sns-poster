const express = require("express");
const customerStore = require("../lib/customerStore");
const { requireAuth } = require("../middleware/requireAuth");
const { getXSurcharge } = require("../lib/surchargeConfig");
const { getStripe } = require("../lib/stripeClient");
const { planKey, pricesForPlan } = require("../lib/stripePricing");
const { computeGraduatedAmount } = require("../lib/stripeTierPricing");
const { getScheduledPostsSummary } = require("../lib/scheduledPostStore");
const { parseMonthParam, isPastMonth } = require("../lib/monthParam");

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

    // trialEndsAtをStripeのtrial_endにそのまま設定する。これによりbilling_cycle_anchorが
    // 自動的にtrial_endと同じ日付に設定され（Stripe公式ドキュメント「トライアル期間を使用した
    // 請求期間の変更」参照。実際にテスト用subscriptionで検証済み: trial_end===billing_cycle_anchor）、
    // 月末日のずれもStripe側で自動吸収される（例: アンカーが1/31なら2月は2/28
    // （うるう年は2/29）、3月は3/31、4月は4/30。「存在しない場合は翌月に繰り越す」のではなく
    // 「その月の最終日」になる点に注意。カスタムロジックの追加は不要）。
    //
    // trial_endは、Stripe Checkout（stripe.checkout.sessions.create）経由の場合
    // 「現在時刻より2日以上先」である必要がある（実際にCheckout Session作成で検証済み。
    // 生のSubscriptions APIなら60秒程度でも通るが、ここではCheckoutを使っているため
    // Checkout側の制約に従う）。既にトライアル終了間際（2日未満）・終了済みの顧客が
    // 今から決済登録する場合はtrial_endを設定せず、従来通り即時課金にフォールバックする
    // （トライアル終了間際に決済登録した顧客は、最大で数日分早く課金される可能性が残る）。
    const MIN_TRIAL_END_LEAD_SECONDS = 2 * 24 * 60 * 60 + 5 * 60; // 2日+5分（安全マージン）
    const subscriptionData = {};
    if (req.customer.trialEndsAt) {
      const trialEndSeconds = Math.floor(new Date(req.customer.trialEndsAt).getTime() / 1000);
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (trialEndSeconds > nowSeconds + MIN_TRIAL_END_LEAD_SECONDS) {
        subscriptionData.trial_end = trialEndSeconds;
      }
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
      ...(Object.keys(subscriptionData).length > 0 ? { subscription_data: subscriptionData } : {}),
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

// customerIdはクエリパラメータではなく、他のbilling系エンドポイント同様
// requireAuthが設定するreq.customer.id（認証済み本人のみ）を使う（IDOR対策）。
router.get("/api/billing/upcoming", requireAuth, async (req, res) => {
  const parsed = parseMonthParam(req.query.month);
  if (!parsed) {
    return res.status(400).json({ error: "invalid_month" });
  }
  if (isPastMonth(parsed.year, parsed.month)) {
    return res.status(400).json({ error: "month_in_past" });
  }

  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: "stripe_not_configured" });
  }

  const plan = planKey(req.customer);
  const prices = pricesForPlan(plan);
  if (!prices || !prices.base || !prices.metered || !prices.meteredX) {
    console.error(`[billing/upcoming] price not configured for plan=${JSON.stringify(req.customer.plan)}`);
    return res.status(500).json({ error: "plan_not_configured" });
  }

  try {
    const fromInvoice = await tryUpcomingInvoiceAmounts(stripe, req.customer, prices, parsed.year, parsed.month);
    if (fromInvoice) {
      return res.json({ ...fromInvoice, isEstimate: true });
    }

    const predicted = await predictFromScheduledPosts(stripe, req.customer, prices, parsed.year, parsed.month);
    res.json({ ...predicted, isEstimate: true });
  } catch (err) {
    console.error(`[billing/upcoming] failed customerId=${req.customer.id}:`, err);
    res.status(500).json({ error: "internal_error" });
  }
});

// Stripeのupcoming invoice previewが指定月の請求対象期間をカバーしていれば、
// その明細行（Stripeが既に段階制課金込みで計算済みの実額に近い値）を集計して返す。
// サブスクリプション未作成（トライアル中等）・対象期間外の場合はnullを返し、
// predictFromScheduledPostsへフォールバックする。
async function tryUpcomingInvoiceAmounts(stripe, customer, prices, year, month) {
  if (!customer.stripeSubscriptionId) return null;

  let preview;
  try {
    preview = await stripe.invoices.createPreview({ customer: customer.stripeCustomerId });
  } catch (err) {
    console.error(`[billing/upcoming] createPreview failed customerId=${customer.id}:`, err);
    return null;
  }

  const monthStart = new Date(year, month - 1, 1).getTime() / 1000;
  if (monthStart < preview.period_start || monthStart >= preview.period_end) return null;

  let basicFee = 0;
  let usageFee = 0;
  let xSurcharge = 0;
  for (const line of preview.lines.data) {
    const priceId = line.price && line.price.id;
    if (priceId === prices.base) basicFee += line.amount;
    else if (priceId === prices.metered) usageFee += line.amount;
    else if (priceId === prices.meteredX) xSurcharge += line.amount;
  }
  return { basicFee, usageFee, xSurcharge, total: basicFee + usageFee + xSurcharge };
}

// トライアル終了日（customer.trialEndsAt）の翌日を「本稼働開始日」とする。
// この日を含む月が初回請求月（基本料金のみ）、以降は毎月請求される前提。
// 実際のStripeサブスクリプションのbilling_cycle_anchor（日単位、月末日のずれ調整）までは
// 再現せず、請求予測カードが元々カレンダー月単位で集計している都合に合わせ、
// 「本稼働開始日が属する月」を基準にした月単位の近似とする。
// customer.trialEndsAtは「表向き」の日数より3日長い内部バッファ込みの値
// （routes/auth.js の TRIAL_INTERNAL_BUFFER_DAYS 参照）。実際にStripeへ請求される
// タイミングと一致させるため、ここでは意図的にそのまま（バッファ込みで）使う。
function getActivationYearMonth(customer) {
  if (!customer.trialEndsAt) return null;
  const trialEnd = new Date(customer.trialEndsAt);
  const activation = new Date(trialEnd.getFullYear(), trialEnd.getMonth(), trialEnd.getDate() + 1);
  return { year: activation.getFullYear(), month: activation.getMonth() + 1 };
}

// 実請求サイクル外の月は、scheduled_postsの予定件数をStripeのPrice tiers（単一の情報源）に
// 当てはめて予測する。基本料金・従量単価をこのコードにハードコードしない。
// トライアル中（本稼働開始日より前の月）は請求ゼロ、本稼働開始月は基本料金のみ、
// それ以降は基本料金＋前月分の従量料金・Xサーチャージ（後払い方式）を予測する。
async function predictFromScheduledPosts(stripe, customer, prices, year, month) {
  const activation = getActivationYearMonth(customer);
  if (activation) {
    const targetKey = year * 12 + month;
    const activationKey = activation.year * 12 + activation.month;

    if (targetKey < activationKey) {
      // トライアル期間中はまだ本稼働していないため請求は発生しない
      return { basicFee: 0, usageFee: 0, xSurcharge: 0, total: 0 };
    }
    if (targetKey === activationKey) {
      // 本稼働開始月の初回請求は基本料金のみ（従量分は翌月請求）
      const basePrice = await stripe.prices.retrieve(prices.base);
      const basicFee = basePrice.unit_amount || 0;
      return { basicFee, usageFee: 0, xSurcharge: 0, total: basicFee };
    }
  }

  // 2回目以降の請求（後払い）は、前月分の予定投稿件数から従量料金・Xサーチャージを予測する。
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;

  const [basePrice, meteredPrice, meteredXPrice, summary] = await Promise.all([
    stripe.prices.retrieve(prices.base),
    stripe.prices.retrieve(prices.metered, { expand: ["tiers"] }),
    stripe.prices.retrieve(prices.meteredX, { expand: ["tiers"] }),
    getScheduledPostsSummary(customer.id, prevYear, prevMonth),
  ]);

  const basicFee = basePrice.unit_amount || 0;
  const usageFee = computeGraduatedAmount(meteredPrice.tiers, summary.totalCount);
  const xSurcharge = computeGraduatedAmount(meteredXPrice.tiers, summary.xUrlCount);
  return { basicFee, usageFee, xSurcharge, total: basicFee + usageFee + xSurcharge };
}

module.exports = router;
