const express = require("express");
const customerStore = require("../lib/customerStore");
const { requireAuth, blockViewerRole, blockEditorRole, blockApproverRole } = require("../middleware/requireAuth");
const { getXSurcharge } = require("../lib/surchargeConfig");
const { getStripe, ensureStripeCustomer, applyInvoiceRenderingTemplate } = require("../lib/stripeClient");
const { planKey, pricesForPlan } = require("../lib/stripePricing");
const { computePriceAmount } = require("../lib/stripeTierPricing");
const { getCurrentBillingCycle, getCombinedPostCounts } = require("../lib/billingCycle");
const { resolvePriorities, findPrimary, findBackup } = require("../lib/paymentMethodPriority");
const { BACKUP_CARD_CHARGED_EMAIL, PAYMENT_SUCCEEDED_EMAIL } = require("../lib/emailTemplates");
const { sendCustomerMail } = require("../lib/customerMailer");
const { notifyFailure } = require("../lib/mailer");

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
    const stripeCustomerId = await ensureStripeCustomer(stripe, req.customer);

    // 請求書の項目グルーピング・表示順を制御するInvoice Rendering Templateをプランに応じて
    // 設定する。表示上の見た目のみに関わる非本質的な処理のため、失敗してもチェックアウト
    // 自体は止めない（ログのみ）。
    try {
      await applyInvoiceRenderingTemplate(stripe, stripeCustomerId, planKey(req.customer));
    } catch (err) {
      console.error(`[billing/create-checkout-session] failed to apply invoice rendering template customerId=${req.customer.id}:`, err);
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
    // 消費税（10%、手動作成したTax Rateオブジェクト）。サブスクリプションのdefault_tax_ratesとして
    // 設定することで、以後の全請求（基本料金・従量料金・Xサーチャージ）に自動で上乗せされる
    // （Price側のtax_behavior: exclusiveと組み合わせて外税計算になる。2026-08-28追加）。
    // 未設定時は税なしのまま進める（Checkout Session自体を止めない）。
    if (process.env.STRIPE_TAX_RATE_ID) {
      subscriptionData.default_tax_rates = [process.env.STRIPE_TAX_RATE_ID];
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
router.post("/api/billing/change-plan", requireAuth, blockViewerRole, blockEditorRole, blockApproverRole, express.json(), async (req, res) => {
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

    // Invoice Rendering Templateも新プランのものに付け替える（呼ぶたびに上書きされるため、
    // 古いプランのテンプレートIDが残ることはない）。表示上の見た目のみに関わる非本質的な
    // 処理のため、失敗してもプラン変更自体（課金対象Priceの切り替え）は取り消さない。
    try {
      await applyInvoiceRenderingTemplate(stripe, req.customer.stripeCustomerId, targetPlan);
    } catch (err) {
      console.error(
        `[billing/change-plan] failed to apply invoice rendering template customerId=${req.customer.id} to=${targetPlan}:`,
        err
      );
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

// ============================================================
// お支払い方法（カード）管理
// カードの実データ（下4桁・有効期限等）はStripeのみを正としmicroCMSにはミラーしない。
// 一覧表示のたびにStripeへ都度問い合わせる。
// ============================================================

function requireAdminRole(req, res) {
  if (customerStore.roleOf(req.user) !== "管理者") {
    res.status(403).json({ error: "forbidden", message: "お支払い方法の管理はアカウント管理者のみ実行できます。" });
    return false;
  }
  return true;
}

// カード一覧の閲覧のみ、閲覧者ロールにも許可する（表示専用。追加・削除・入替は
// 引き続きrequireAdminRoleで管理者限定のまま）。
function requireAdminOrViewerRole(req, res) {
  const role = customerStore.roleOf(req.user);
  if (role !== "管理者" && role !== "閲覧者") {
    res.status(403).json({ error: "forbidden", message: "お支払い方法の確認はアカウント管理者のみ実行できます。" });
    return false;
  }
  return true;
}

// Stripe.js（Stripe Elements）が使う公開可能キー。個人情報を含まないため認証不要
// （x-surchargeと同じ公開設定エンドポイント）。
router.get("/api/billing/stripe-publishable-key", (req, res) => {
  const key = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!key) {
    return res.status(500).json({ error: "stripe_not_configured" });
  }
  res.json({ publishableKey: key });
});

router.post("/api/billing/payment-methods/setup-intent", requireAuth, async (req, res) => {
  if (!requireAdminRole(req, res)) return;
  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: "stripe_not_configured" });
  }

  try {
    const stripeCustomerId = await ensureStripeCustomer(stripe, req.customer);
    const existing = await stripe.paymentMethods.list({ customer: stripeCustomerId, type: "card" });
    if (existing.data.length >= 2) {
      return res.status(409).json({ error: "card_limit_reached", message: "お支払い方法は2枚まで登録できます。" });
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: stripeCustomerId,
      payment_method_types: ["card"],
    });
    res.json({ clientSecret: setupIntent.client_secret });
  } catch (err) {
    console.error(`[billing/payment-methods/setup-intent] failed customerId=${req.customer.id}:`, err);
    res.status(500).json({ error: "stripe_error", message: "カード登録の準備に失敗しました。しばらくしてから再度お試しください。" });
  }
});

// SetupIntent確定後、フロントから確認された PaymentMethod に優先度（primary/backup）を
// 付与する。setup-intent発行時点では2枚未満だったが、その後confirmまでの間に別タブで
// もう1枚登録されてしまうレースに備え、ここでも枚数を再検証する（不整合が起きていれば
// 今回アタッチされたカードをdetachして取り消す）。
router.post("/api/billing/payment-methods/confirm", requireAuth, express.json(), async (req, res) => {
  if (!requireAdminRole(req, res)) return;
  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: "stripe_not_configured" });
  }

  const { paymentMethodId } = req.body || {};
  if (!paymentMethodId) {
    return res.status(400).json({ error: "payment_method_id_required" });
  }

  try {
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    if (pm.customer !== req.customer.stripeCustomerId) {
      return res.status(403).json({ error: "forbidden" });
    }

    const others = await stripe.paymentMethods.list({ customer: req.customer.stripeCustomerId, type: "card" });
    const otherCount = others.data.filter((c) => c.id !== paymentMethodId).length;
    if (otherCount >= 2) {
      await stripe.paymentMethods.detach(paymentMethodId);
      return res.status(409).json({ error: "card_limit_reached", message: "お支払い方法は2枚まで登録できます。" });
    }

    const priority = otherCount === 0 ? "primary" : "backup";
    await stripe.paymentMethods.update(paymentMethodId, { metadata: { priority } });
    if (priority === "primary") {
      await stripe.customers.update(req.customer.stripeCustomerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    }

    res.json({
      id: pm.id,
      brand: pm.card.brand,
      last4: pm.card.last4,
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
      priority,
    });
  } catch (err) {
    console.error(`[billing/payment-methods/confirm] failed customerId=${req.customer.id}:`, err);
    res.status(500).json({ error: "stripe_error", message: "カード登録の確定に失敗しました。しばらくしてから再度お試しください。" });
  }
});

router.get("/api/billing/payment-methods", requireAuth, async (req, res) => {
  if (!requireAdminOrViewerRole(req, res)) return;
  if (!req.customer.stripeCustomerId) {
    return res.json({ cards: [] });
  }

  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: "stripe_not_configured" });
  }

  try {
    const [list, stripeCustomer] = await Promise.all([
      stripe.paymentMethods.list({ customer: req.customer.stripeCustomerId, type: "card" }),
      stripe.customers.retrieve(req.customer.stripeCustomerId),
    ]);
    const defaultPaymentMethodId = stripeCustomer.invoice_settings && stripeCustomer.invoice_settings.default_payment_method;
    const resolved = resolvePriorities(list.data, defaultPaymentMethodId);

    // 既存有償顧客（Checkout経由で1枚だけカードを持ちmetadata未設定）を検知したら、
    // 以降の呼び出しがフォールバック計算を経ずに済むよう自己修復する。失敗しても
    // 一覧表示自体は継続する（表示上はresolvePriorities側のフォールバックで賄えるため）。
    await Promise.all(
      resolved
        .filter((r) => r.isLegacyDefault)
        .map((r) =>
          stripe.paymentMethods.update(r.paymentMethod.id, { metadata: { priority: "primary" } }).catch((err) => {
            console.error(`[billing/payment-methods] legacy priority backfill failed customerId=${req.customer.id}:`, err);
          })
        )
    );

    // metadata上のprimaryとStripe側のdefault_payment_methodが食い違っている場合
    // （Stripeダッシュボードでの直接操作等、当アプリのAPIを経由しない変更が原因で起こりうる）、
    // 実際に請求時に使われるのはStripe側のdefault_payment_methodのため、表示（metadata）に
    // 合わせて同期する。失敗しても一覧表示自体は継続する。
    const primaryEntry = resolved.find((r) => r.priority === "primary");
    if (primaryEntry && !primaryEntry.isLegacyDefault && primaryEntry.paymentMethod.id !== defaultPaymentMethodId) {
      await stripe.customers
        .update(req.customer.stripeCustomerId, {
          invoice_settings: { default_payment_method: primaryEntry.paymentMethod.id },
        })
        .catch((err) => {
          console.error(`[billing/payment-methods] default_payment_method drift sync failed customerId=${req.customer.id}:`, err);
        });
    }

    const cards = resolved
      .map((r) => ({
        id: r.paymentMethod.id,
        brand: r.paymentMethod.card.brand,
        last4: r.paymentMethod.card.last4,
        expMonth: r.paymentMethod.card.exp_month,
        expYear: r.paymentMethod.card.exp_year,
        priority: r.priority,
      }))
      .sort((a, b) => (a.priority === "primary" ? -1 : b.priority === "primary" ? 1 : 0));

    res.json({ cards });
  } catch (err) {
    console.error(`[billing/payment-methods] list failed customerId=${req.customer.id}:`, err);
    res.status(500).json({ error: "stripe_error", message: "お支払い方法の取得に失敗しました。しばらくしてから再度お試しください。" });
  }
});

router.delete("/api/billing/payment-methods/:paymentMethodId", requireAuth, async (req, res) => {
  if (!requireAdminRole(req, res)) return;
  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: "stripe_not_configured" });
  }

  const { paymentMethodId } = req.params;

  try {
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    if (pm.customer !== req.customer.stripeCustomerId) {
      return res.status(403).json({ error: "forbidden" });
    }

    const list = await stripe.paymentMethods.list({ customer: req.customer.stripeCustomerId, type: "card" });
    const isLastCard = list.data.length === 1;
    if (isLastCard && req.customer.stripeSubscriptionId && !customerStore.isCanceled(req.customer)) {
      return res.status(409).json({
        error: "last_card_with_active_subscription",
        message: "有効なサブスクリプションがある間は、最後の1枚のカードを削除できません。先に別のカードを登録してから削除してください。",
      });
    }

    const stripeCustomer = await stripe.customers.retrieve(req.customer.stripeCustomerId);
    const defaultPaymentMethodId = stripeCustomer.invoice_settings && stripeCustomer.invoice_settings.default_payment_method;
    const resolved = resolvePriorities(list.data, defaultPaymentMethodId);
    const deletedWasPrimary = resolved.find((r) => r.paymentMethod.id === paymentMethodId)?.priority === "primary";

    await stripe.paymentMethods.detach(paymentMethodId);

    const remaining = resolved.filter((r) => r.paymentMethod.id !== paymentMethodId);
    if (remaining.length === 0) {
      // 削除したカードがprimary/backupいずれのタグだったかに関わらず、0枚になった場合は
      // default_payment_methodを必ずクリアする。タグ付けがStripe側の実データと食い違って
      // いた場合（Dashboard操作等での drift）でも、detach済みのIDを参照したまま残さないため。
      await stripe.customers.update(req.customer.stripeCustomerId, {
        invoice_settings: { default_payment_method: null },
      });
    } else if (deletedWasPrimary) {
      const promoted = remaining[0];
      await stripe.paymentMethods.update(promoted.paymentMethod.id, { metadata: { priority: "primary" } });
      await stripe.customers.update(req.customer.stripeCustomerId, {
        invoice_settings: { default_payment_method: promoted.paymentMethod.id },
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(`[billing/payment-methods] delete failed customerId=${req.customer.id} paymentMethodId=${paymentMethodId}:`, err);
    res.status(500).json({ error: "stripe_error", message: "カードの削除に失敗しました。しばらくしてから再度お試しください。" });
  }
});

// プライマリ/バックアップの入れ替え。カード番号・有効期限の「編集」は不可という要件は
// Stripe側でカード自体を書き換えられないことに由来するもので、優先度（当アプリ側の
// metadata）の入れ替えはその制約とは無関係のため、削除→再登録を経由せずその場で行える。
// 2枚registered時のみ意味を持つ操作。
router.post("/api/billing/payment-methods/swap", requireAuth, async (req, res) => {
  if (!requireAdminRole(req, res)) return;
  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: "stripe_not_configured" });
  }
  if (!req.customer.stripeCustomerId) {
    return res.status(400).json({ error: "swap_requires_two_cards", message: "入れ替えにはカードが2枚登録されている必要があります。" });
  }

  try {
    const [list, stripeCustomer] = await Promise.all([
      stripe.paymentMethods.list({ customer: req.customer.stripeCustomerId, type: "card" }),
      stripe.customers.retrieve(req.customer.stripeCustomerId),
    ]);
    const defaultPaymentMethodId = stripeCustomer.invoice_settings && stripeCustomer.invoice_settings.default_payment_method;
    const resolved = resolvePriorities(list.data, defaultPaymentMethodId);

    if (resolved.length !== 2) {
      return res.status(400).json({ error: "swap_requires_two_cards", message: "入れ替えにはカードが2枚登録されている必要があります。" });
    }
    const primary = findPrimary(resolved);
    const backup = findBackup(resolved);

    await stripe.paymentMethods.update(primary.paymentMethod.id, { metadata: { priority: "backup" } });
    await stripe.paymentMethods.update(backup.paymentMethod.id, { metadata: { priority: "primary" } });
    await stripe.customers.update(req.customer.stripeCustomerId, {
      invoice_settings: { default_payment_method: backup.paymentMethod.id },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(`[billing/payment-methods] swap failed customerId=${req.customer.id}:`, err);
    res.status(500).json({ error: "stripe_error", message: "入れ替えに失敗しました。しばらくしてから再度お試しください。" });
  }
});

// invoice.payment_failed ウェブフック本体。プライマリカードの決済失敗時、バックアップ
// カードが登録されていれば即時に再決済を試みる（要件: Stripeのデフォルト挙動では
// 同一カードへのSmart Retryのみで、別カードへの自動切替は行われないため）。
async function handleInvoicePaymentFailed(stripe, event) {
  const invoice = event.data.object;
  const stripeCustomerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer && invoice.customer.id;

  if (!stripeCustomerId) {
    console.warn(`[billing/webhook] invoice.payment_failed without customer, invoiceId=${invoice.id}`);
    return;
  }

  const customer = await customerStore.getCustomerByStripeCustomerId(stripeCustomerId);
  if (!customer) {
    console.warn(`[billing/webhook] invoice.payment_failed: no matching customer for stripeCustomerId=${stripeCustomerId} invoiceId=${invoice.id}`);
    return;
  }

  // Webhookイベントの再送対策。invoices.payのidempotencyKeyは「二重課金」は防ぐが、
  // 再送時にこのハンドラ自体は最初から最後まで再実行されるため、通知メールは
  // ガードなしでは重複送信されてしまう。event.dataは再送時も生成時点のスナップショットの
  // ままなので、必ずinvoiceを再取得して「現在の」metadataを見る（event.data.object.metadataを
  // 見ると、初回処理で書き込んだマーカーが再送イベントに反映されず永久に検知できない）。
  const freshInvoice = await stripe.invoices.retrieve(invoice.id);
  if (freshInvoice.metadata && freshInvoice.metadata.backup_retry_event_id === event.id) {
    console.info(`[billing/webhook] invoice.payment_failed: event ${event.id} already processed for invoice ${invoice.id}, skipping (redelivery)`);
    return;
  }
  // 通常Stripeは支払い済みのinvoiceに対してinvoice.payment_failedを再送しないが、古い
  // イベントの手動再送（Stripeダッシュボードの「イベントを再送信」等）で、既に別経路
  // （バックアップ課金・顧客による直接支払い等）で解決済みのinvoiceに対してこのハンドラが
  // 呼ばれる可能性はある。invoices.payを既払いinvoiceに呼ぶとStripe側がエラーを返し、
  // 下のcatchで「予期しないエラー」として誤って運用アラートが飛んでしまうため、ここで
  // 事前に弾く。
  if (freshInvoice.status === "paid") {
    console.info(`[billing/webhook] invoice.payment_failed: invoice ${invoice.id} already paid, skipping`);
    return;
  }

  const [cards, stripeCustomer] = await Promise.all([
    stripe.paymentMethods.list({ customer: stripeCustomerId, type: "card" }),
    stripe.customers.retrieve(stripeCustomerId),
  ]);
  const defaultPaymentMethodId = stripeCustomer.invoice_settings && stripeCustomer.invoice_settings.default_payment_method;
  const resolved = resolvePriorities(cards.data, defaultPaymentMethodId);
  const backup = findBackup(resolved);

  if (!backup) {
    console.info(`[billing/webhook] invoice.payment_failed: no backup card, leaving to normal dunning. customerId=${customer.id} invoiceId=${invoice.id}`);
    return;
  }

  try {
    // idempotencyKeyはこのWebhookイベント自体の再送による二重課金を防ぐためのもの
    // （event.idを使う。Stripe自身の督促リトライは別イベント＝別event.idとして発火するため、
    // そちらは正しく再度リトライ対象になる＝意図した挙動）。
    const paidInvoice = await stripe.invoices.pay(
      invoice.id,
      { payment_method: backup.paymentMethod.id },
      { idempotencyKey: `invoice-backup-retry:${event.id}` }
    );
    console.info(`[billing/webhook] backup card charge succeeded customerId=${customer.id} invoiceId=${invoice.id}`);

    // 通知メール送信の前にマーカーを書き込む。ここで処理が落ちればメール未送信のまま
    // 終わる可能性はあるが（許容）、逆順にすると再送時にメール二重送信を防げなくなるため、
    // 「稀に送られない」より「絶対に二重送信しない」を優先する。
    await stripe.invoices.update(invoice.id, {
      metadata: { ...freshInvoice.metadata, backup_retry_event_id: event.id },
    });

    const mailResult = await sendCustomerMail({
      toEmail: customer.email,
      subject: BACKUP_CARD_CHARGED_EMAIL.subject,
      text: BACKUP_CARD_CHARGED_EMAIL.body(paidInvoice.hosted_invoice_url),
    });
    if (!mailResult.ok) {
      console.warn(`[billing/webhook] backup-charged notification mail not sent (${mailResult.error}) customerId=${customer.id}`);
    }
  } catch (payErr) {
    // バックアップカードも失敗した、または一時的なStripe側エラー。通常のStripe自動督促
    // （dunning）に委ねるため、ここでは何もしない（バックアップが無い/失敗した場合は
    // 追加処理をしないという要件通り）。
    console.error(`[billing/webhook] backup card charge failed customerId=${customer.id} invoiceId=${invoice.id}:`, payErr.message);
    // カード拒否そのもの（想定内）と、Stripe API自体の異常（想定外）を分けて、
    // 後者だけ運用アラートを飛ばす。
    if (payErr.type !== "StripeCardError") {
      await notifyFailure(
        "[edgeailab] バックアップカード課金処理で予期しないエラー",
        [`customerId: ${customer.id}`, `invoiceId: ${invoice.id}`, `エラー: ${payErr.message}`].join("\n")
      );
    }
  }
}

// invoice.paid ウェブフック本体。決済成功のたびに顧客へ請求金額を通知する（2026-08-28追加）。
// Stripe側のWebhookエンドポイントには`invoice.payment_succeeded`ではなく`invoice.paid`が
// 登録済みのため、実装もそれに合わせる（実機で前者を購読していないため発火しないことを確認済み）。
async function handleInvoicePaid(stripe, event) {
  const invoice = event.data.object;
  const stripeCustomerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer && invoice.customer.id;

  if (!stripeCustomerId) {
    console.warn(`[billing/webhook] invoice.paid without customer, invoiceId=${invoice.id}`);
    return;
  }

  const customer = await customerStore.getCustomerByStripeCustomerId(stripeCustomerId);
  if (!customer) {
    console.warn(`[billing/webhook] invoice.paid: no matching customer for stripeCustomerId=${stripeCustomerId} invoiceId=${invoice.id}`);
    return;
  }

  // handleInvoicePaymentFailedと同じ理由（Webhook再送対策）で、必ずinvoiceを再取得して
  // 「現在の」metadataを見る。event.data.objectは生成時点のスナップショットのままのため。
  const freshInvoice = await stripe.invoices.retrieve(invoice.id);
  if (freshInvoice.metadata && freshInvoice.metadata.payment_succeeded_notified_event_id === event.id) {
    console.info(`[billing/webhook] invoice.paid: event ${event.id} already processed for invoice ${invoice.id}, skipping (redelivery)`);
    return;
  }

  // 通知メール送信の前にマーカーを書き込む（二重送信より稀な未送信を許容する方針、
  // handleInvoicePaymentFailedと同様）。
  await stripe.invoices.update(invoice.id, {
    metadata: { ...freshInvoice.metadata, payment_succeeded_notified_event_id: event.id },
  });

  const mailResult = await sendCustomerMail({
    toEmail: customer.email,
    subject: PAYMENT_SUCCEEDED_EMAIL.subject,
    text: PAYMENT_SUCCEEDED_EMAIL.body(freshInvoice.total, freshInvoice.hosted_invoice_url),
  });
  if (!mailResult.ok) {
    console.warn(`[billing/webhook] payment-succeeded notification mail not sent (${mailResult.error}) customerId=${customer.id}`);
  }
}

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
    } else if (event.type === "invoice.payment_failed") {
      await handleInvoicePaymentFailed(stripe, event);
    } else if (event.type === "invoice.paid") {
      await handleInvoicePaid(stripe, event);
    }
    res.json({ received: true });
  } catch (err) {
    console.error("[billing/webhook] handling failed:", err);
    res.status(500).send("internal error");
  }
});

// customerIdはクエリパラメータではなく、他のbilling系エンドポイント同様
// requireAuthが設定するreq.customer.id（認証済み本人のみ）を使う（IDOR対策）。
// 月選択パラメータは持たない（2026-08-26設計変更）。「次回いくら支払うか」を知るための
// 機能であり、常に「今、進行中の1周期」だけを対象にする。
router.get("/api/billing/upcoming", requireAuth, async (req, res) => {
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
    const forecast = await estimateBillingForecast(stripe, req.customer, prices);
    res.json({ ...forecast, isEstimate: true });
  } catch (err) {
    console.error(`[billing/upcoming] failed customerId=${req.customer.id}:`, err);
    res.status(500).json({ error: "internal_error" });
  }
});

// 「今、進行中の周期」の請求を予測する。基本料金＝次回決算日から始まる次周期分（先払い、
// 「yyyy年mm月分」のラベル用にbasicFeePeriodも返す）。従量料金・Xサーチャージ＝
// billingCycle.getCombinedPostCounts（前回決算日〜今日の実績＋今日〜次回決算日の予定を
// 合算した件数）を、StripeのPrice tiers（単一の情報源）に当てはめて算出する（後払い＋予測）。
// まだ一度も決済していない（本稼働前、cycleStart=null）場合は基本料金のみ。
async function estimateBillingForecast(stripe, customer, prices) {
  const cycle = await getCurrentBillingCycle(stripe, customer);
  if (!cycle) {
    return { basicFee: 0, usageFee: 0, xSurcharge: 0, total: 0, periodStart: null, periodEnd: null, basicFeePeriod: null };
  }

  const basePrice = await stripe.prices.retrieve(prices.base);
  const basicFee = basePrice.unit_amount || 0;
  const basicFeePeriod = { year: cycle.cycleEnd.getFullYear(), month: cycle.cycleEnd.getMonth() + 1 };

  if (!cycle.cycleStart) {
    return {
      basicFee,
      usageFee: 0,
      xSurcharge: 0,
      total: basicFee,
      periodStart: null,
      periodEnd: cycle.cycleEnd.toISOString(),
      basicFeePeriod,
    };
  }

  const [meteredPrice, meteredXPrice, combined] = await Promise.all([
    stripe.prices.retrieve(prices.metered, { expand: ["tiers"] }),
    stripe.prices.retrieve(prices.meteredX, { expand: ["tiers"] }),
    getCombinedPostCounts(customer, cycle.cycleStart, cycle.cycleEnd),
  ]);

  const usageFee = computePriceAmount(meteredPrice, combined.totalCount);
  const xSurcharge = computePriceAmount(meteredXPrice, combined.xUrlCount);
  return {
    basicFee,
    usageFee,
    xSurcharge,
    total: basicFee + usageFee + xSurcharge,
    periodStart: cycle.cycleStart.toISOString(),
    periodEnd: cycle.cycleEnd.toISOString(),
    basicFeePeriod,
  };
}

// handleInvoicePaymentFailedはExpressルートには直接ならない内部関数だが、
// 自動テスト（src/routes/billing.webhook.test.js）から直接呼び出せるよう、Routerオブジェクト
// （関数）にプロパティとして公開する。Router自体はapp.use(billingRoutes)でそのまま使われるため、
// この公開はExpressの動作に影響しない。
router.handleInvoicePaymentFailed = handleInvoicePaymentFailed;
router.handleInvoicePaid = handleInvoicePaid;

module.exports = router;
