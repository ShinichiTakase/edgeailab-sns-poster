// trialLimitAutoActivation.js のリグレッションテスト。
// 「支払い方法未登録なら何もしない」「登録済みならサブスクリプションを即時作成し
// status:'active'へ切り替える」「作成直後の決済が失敗（incomplete等）した場合は
// statusを更新しない」を検証する。Stripe・microCMSへの実アクセスは行わず、
// stripeClient・stripePricing・customerStoreをフェイクに差し替える
// （billing.paymentMethods.test.jsと同じ「requireの前にexportを差し替える」パターン）。
const test = require("node:test");
const assert = require("node:assert/strict");

const stripeClient = require("./stripeClient");
const stripePricing = require("./stripePricing");
const customerStore = require("./customerStore");
const customerMailer = require("./customerMailer");

let fakeCards = [];
let createdSubscriptions = [];
let subscriptionStatusToReturn = "active";
let subscriptionCreateShouldThrow = false;
let existingSubscriptions = [];
let subscriptionCreateOptions = [];

stripeClient.getStripe = () => ({
  paymentMethods: {
    list: async () => ({ data: fakeCards }),
  },
  customers: {
    create: async () => ({ id: "cus_new" }),
  },
  subscriptions: {
    list: async () => ({ data: existingSubscriptions }),
    create: async (params, options) => {
      if (subscriptionCreateShouldThrow) throw new Error("stripe_down");
      createdSubscriptions.push(params);
      subscriptionCreateOptions.push(options);
      return { id: "sub_new", status: subscriptionStatusToReturn, metadata: params.metadata };
    },
  },
});

stripePricing.pricesForPlan = () => ({
  base: "price_base",
  metered: "price_metered",
  meteredX: "price_metered_x",
});
stripePricing.planKey = (customer) => {
  const value = Array.isArray(customer.plan) ? customer.plan[0] : customer.plan;
  return typeof value === "string" ? value.toLowerCase() : null;
};

let updatedCustomers = [];
customerStore.updateCustomer = async (id, patch) => {
  updatedCustomers.push({ id, patch });
};

let sentMails = [];
customerMailer.sendCustomerMail = async ({ toEmail, subject, text }) => {
  sentMails.push({ toEmail, subject, text });
  return { ok: true };
};

const { activateAfterTrialLimitIfNeeded, sendTrialPostLimitReachedEmailIfNeeded } = require("./trialLimitAutoActivation");

test.beforeEach(() => {
  fakeCards = [];
  createdSubscriptions = [];
  updatedCustomers = [];
  sentMails = [];
  subscriptionStatusToReturn = "active";
  subscriptionCreateShouldThrow = false;
  existingSubscriptions = [];
  subscriptionCreateOptions = [];
});

function fakeLogger() {
  return { logError: () => {} };
}

test("支払い方法未登録: 何もしない（no_payment_method）", async () => {
  fakeCards = [];
  const customer = { id: "cust_1", stripeCustomerId: "cus_1", plan: ["Standard"] };
  const result = await activateAfterTrialLimitIfNeeded({ customer, logger: fakeLogger() });

  assert.equal(result, "no_payment_method");
  assert.equal(createdSubscriptions.length, 0);
  assert.equal(updatedCustomers.length, 0);
});

test("支払い方法登録済み: サブスクリプションを即時作成しstatus:activeへ切り替える", async () => {
  fakeCards = [{ id: "pm_1" }];
  const customer = { id: "cust_1", stripeCustomerId: "cus_1", plan: ["Standard"] };
  const result = await activateAfterTrialLimitIfNeeded({ customer, logger: fakeLogger() });

  assert.equal(result, "activated");
  assert.equal(createdSubscriptions.length, 1);
  // trial_endを指定していない（即時課金）ことを確認
  assert.equal("trial_end" in createdSubscriptions[0], false);
  assert.deepEqual(
    createdSubscriptions[0].items.map((i) => i.price),
    ["price_base", "price_metered", "price_metered_x"]
  );
  assert.equal(createdSubscriptions[0].metadata.edgeailab_trial_activation_key, "trial-limit:cust_1");
  assert.equal(subscriptionCreateOptions[0].idempotencyKey, "trial-limit:cust_1");

  assert.equal(updatedCustomers.length, 1);
  assert.equal(updatedCustomers[0].id, "cust_1");
  assert.equal(updatedCustomers[0].patch.stripeSubscriptionId, "sub_new");
  assert.deepEqual(updatedCustomers[0].patch.status, ["active"]);
  assert.ok(updatedCustomers[0].patch.trialLimitAutoActivatedAt);
});

test("作成直後の決済が失敗（incomplete）した場合はstatusを更新しない", async () => {
  fakeCards = [{ id: "pm_1" }];
  subscriptionStatusToReturn = "incomplete";
  const customer = { id: "cust_1", stripeCustomerId: "cus_1", plan: ["Standard"] };
  const result = await activateAfterTrialLimitIfNeeded({ customer, logger: fakeLogger() });

  assert.equal(result, "failed");
  assert.equal(updatedCustomers.length, 0);
});

test("Stripe呼び出し自体が例外を投げた場合もfailedを返し、投稿処理側には伝播しない", async () => {
  fakeCards = [{ id: "pm_1" }];
  subscriptionCreateShouldThrow = true;
  const customer = { id: "cust_1", stripeCustomerId: "cus_1", plan: ["Standard"] };
  const result = await activateAfterTrialLimitIfNeeded({ customer, logger: fakeLogger() });

  assert.equal(result, "failed");
  assert.equal(updatedCustomers.length, 0);
});

test("Stripe作成成功後にDB保存だけ失敗しても、再試行は既存subscriptionを再利用する", async () => {
  fakeCards = [{ id: "pm_1" }];
  existingSubscriptions = [{
    id: "sub_created_before_crash",
    status: "active",
    metadata: { edgeailab_trial_activation_key: "trial-limit:cust_1" },
  }];
  const customer = { id: "cust_1", stripeCustomerId: "cus_1", plan: ["Standard"] };

  assert.equal(await activateAfterTrialLimitIfNeeded({ customer, logger: fakeLogger() }), "activated");
  assert.equal(createdSubscriptions.length, 0);
  assert.equal(updatedCustomers.length, 1);
  assert.equal(updatedCustomers[0].patch.stripeSubscriptionId, "sub_created_before_crash");
});

test("同じ業務キーの既存subscriptionがincompleteなら新規契約を重ねない", async () => {
  fakeCards = [{ id: "pm_1" }];
  existingSubscriptions = [{
    id: "sub_incomplete_before_crash",
    status: "incomplete",
    metadata: { edgeailab_trial_activation_key: "trial-limit:cust_1" },
  }];
  const customer = { id: "cust_1", stripeCustomerId: "cus_1", plan: ["Standard"] };

  assert.equal(await activateAfterTrialLimitIfNeeded({ customer, logger: fakeLogger() }), "failed");
  assert.equal(createdSubscriptions.length, 0);
  assert.equal(updatedCustomers.length, 0);
});

test("sendTrialPostLimitReachedEmailIfNeeded: activated時は「本契約へ切り替わりました」の文面で送る", async () => {
  const customer = { id: "cust_1", email: "a@example.com", plan: ["Standard"] };
  const sent = await sendTrialPostLimitReachedEmailIfNeeded({ customer, result: "activated", logger: fakeLogger() });

  assert.equal(sent, true);
  assert.equal(sentMails.length, 1);
  assert.equal(sentMails[0].toEmail, "a@example.com");
  assert.match(sentMails[0].subject, /本契約へ切り替わりました/);
  assert.match(sentMails[0].text, /自動的に切り替わりました/);
  assert.doesNotMatch(sentMails[0].text, /payment\.html/);
});

test("sendTrialPostLimitReachedEmailIfNeeded: no_payment_method時は投稿停止・登録案内の文面で送る", async () => {
  const customer = { id: "cust_1", email: "a@example.com", plan: ["Standard"] };
  const sent = await sendTrialPostLimitReachedEmailIfNeeded({ customer, result: "no_payment_method", logger: fakeLogger() });

  assert.equal(sent, true);
  assert.equal(sentMails.length, 1);
  assert.match(sentMails[0].text, /これ以降の投稿はできません/);
  assert.match(sentMails[0].text, /payment\.html/);
});

test("sendTrialPostLimitReachedEmailIfNeeded: failed時は送信しない", async () => {
  const customer = { id: "cust_1", email: "a@example.com", plan: ["Standard"] };
  const sent = await sendTrialPostLimitReachedEmailIfNeeded({ customer, result: "failed", logger: fakeLogger() });

  assert.equal(sent, false);
  assert.equal(sentMails.length, 0);
});

test("自動本契約化もCheckoutと同じ設定済み税率を新規契約へ渡す", async () => {
  const previous = process.env.STRIPE_TAX_RATE_ID;
  process.env.STRIPE_TAX_RATE_ID = "txr_isolated_audit";
  try {
    fakeCards = [{ id: "pm_1" }];
    const customer = { id: "cust_1", stripeCustomerId: "cus_1", plan: ["Standard"] };
    assert.equal(await activateAfterTrialLimitIfNeeded({ customer, logger: fakeLogger() }), "activated");
    assert.deepEqual(createdSubscriptions[0].default_tax_rates, ["txr_isolated_audit"]);
  } finally {
    if (previous === undefined) delete process.env.STRIPE_TAX_RATE_ID;
    else process.env.STRIPE_TAX_RATE_ID = previous;
  }
});
