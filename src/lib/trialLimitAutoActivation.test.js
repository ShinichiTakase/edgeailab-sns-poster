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

let fakeCards = [];
let createdSubscriptions = [];
let subscriptionStatusToReturn = "active";
let subscriptionCreateShouldThrow = false;

stripeClient.getStripe = () => ({
  paymentMethods: {
    list: async () => ({ data: fakeCards }),
  },
  customers: {
    create: async () => ({ id: "cus_new" }),
  },
  subscriptions: {
    create: async (params) => {
      if (subscriptionCreateShouldThrow) throw new Error("stripe_down");
      createdSubscriptions.push(params);
      return { id: "sub_new", status: subscriptionStatusToReturn };
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

const { activateAfterTrialLimitIfNeeded } = require("./trialLimitAutoActivation");

test.beforeEach(() => {
  fakeCards = [];
  createdSubscriptions = [];
  updatedCustomers = [];
  subscriptionStatusToReturn = "active";
  subscriptionCreateShouldThrow = false;
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
