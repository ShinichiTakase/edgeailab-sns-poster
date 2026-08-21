// GET/DELETE /api/billing/payment-methods のリグレッションテスト。
// 「metadata上のprimaryとStripe側default_payment_methodが食い違っている場合の同期」と、
// 「削除したカードがprimaryタグでなくても、0枚になったらdefault_payment_methodを必ず
// クリアする」の2つの修正を継続的に守るためのもの。Stripe/microCMSへの実アクセスは行わず、
// billing.jsのルーターを実際にHTTPで叩く軽量な統合テスト（supertest等の追加依存は使わない）。
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

// stripeClient.getStripe・customerStore.getCustomerById は、それぞれbilling.js・
// requireAuth.js側で分割代入されるため、billing.js を require する「前」に
// エクスポート自体を差し替えておく必要がある。
const stripeClient = require("../lib/stripeClient");
const customerStore = require("../lib/customerStore");
const { signSession } = require("../lib/jwt");
const { COOKIE_NAME } = require("../lib/jwt");

const TEST_CUSTOMER = {
  id: "cust_internal",
  email: "test@example.com",
  stripeCustomerId: "cus_test",
  stripeSubscriptionId: null,
  status: ["trial"],
  users: [{ userId: "user_1", email: "test@example.com", role: ["管理者"], sessionVersion: 0 }],
};

let currentFakeStripe = null;
stripeClient.getStripe = () => currentFakeStripe;
customerStore.getCustomerById = async (id) => (id === TEST_CUSTOMER.id ? TEST_CUSTOMER : null);

const billingRouter = require("./billing");

// フェイクStripeの顧客+カード状態。paymentMethods.retrieve/list/update/detach と
// customers.retrieve/update のうち、billing.jsが実際に呼ぶものだけを最小限で模倣する。
function createFakeStripeAccount({ cards, defaultPaymentMethodId }) {
  const state = {
    cards: new Map(cards.map((c) => [c.id, { ...c }])),
    defaultPaymentMethodId,
  };
  return {
    _state: state,
    paymentMethods: {
      async retrieve(id) {
        const pm = state.cards.get(id);
        if (!pm) {
          const err = new Error("No such PaymentMethod");
          err.type = "StripeInvalidRequestError";
          throw err;
        }
        return { ...pm };
      },
      async list() {
        return { data: Array.from(state.cards.values()) };
      },
      async update(id, { metadata }) {
        const pm = state.cards.get(id);
        pm.metadata = { ...pm.metadata, ...metadata };
        return { ...pm };
      },
      async detach(id) {
        const pm = state.cards.get(id);
        state.cards.delete(id);
        return { ...pm };
      },
    },
    customers: {
      async retrieve(id) {
        return { id, invoice_settings: { default_payment_method: state.defaultPaymentMethodId } };
      },
      async update(id, { invoice_settings }) {
        if (invoice_settings && "default_payment_method" in invoice_settings) {
          state.defaultPaymentMethodId = invoice_settings.default_payment_method;
        }
        return { id, invoice_settings: { default_payment_method: state.defaultPaymentMethodId } };
      },
    },
  };
}

function card(id, brand, priority) {
  return {
    id,
    customer: TEST_CUSTOMER.stripeCustomerId,
    card: { brand, last4: "4242", exp_month: 12, exp_year: 2030 },
    metadata: priority ? { priority } : {},
  };
}

let server;
let baseUrl;

test.before(async () => {
  const app = express();
  app.use(billingRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function authedRequest(method, path) {
  const token = signSession(TEST_CUSTOMER, TEST_CUSTOMER.users[0]);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      { method, headers: { Cookie: `${COOKIE_NAME}=${token}` } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body || "{}") }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

test("GET一覧: metadataのprimaryとStripe側default_payment_methodが食い違っている場合、default_payment_method側をmetadataに同期する（リグレッション対象）", async () => {
  const primary = card("pm_primary", "visa", "primary");
  const backup = card("pm_backup", "mastercard", "backup");
  currentFakeStripe = createFakeStripeAccount({ cards: [primary, backup], defaultPaymentMethodId: "pm_backup" });

  const res = await authedRequest("GET", "/api/billing/payment-methods");

  assert.equal(res.status, 200);
  const primaryEntry = res.body.cards.find((c) => c.id === "pm_primary");
  assert.equal(primaryEntry.priority, "primary", "表示上はmetadata優先でprimaryのまま");
  assert.equal(
    currentFakeStripe._state.defaultPaymentMethodId,
    "pm_primary",
    "Stripe側のdefault_payment_methodがmetadataのprimaryに同期されること"
  );
});

test("DELETE: primaryタグの無いカード（backupのみ）を削除して0枚になった場合も、default_payment_methodをクリアする（リグレッション対象）", async () => {
  const backupOnly = card("pm_backup_only", "visa", "backup"); // わざとprimaryタグ無し
  currentFakeStripe = createFakeStripeAccount({ cards: [backupOnly], defaultPaymentMethodId: null });

  const res = await authedRequest("DELETE", "/api/billing/payment-methods/pm_backup_only");

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(currentFakeStripe._state.cards.size, 0);
  assert.equal(currentFakeStripe._state.defaultPaymentMethodId, null);
});

test("DELETE: primary削除でbackupが残っていれば、backupがprimaryに昇格しdefault_payment_methodも同期される", async () => {
  const primary = card("pm_primary2", "visa", "primary");
  const backup = card("pm_backup2", "mastercard", "backup");
  currentFakeStripe = createFakeStripeAccount({ cards: [primary, backup], defaultPaymentMethodId: "pm_primary2" });

  const res = await authedRequest("DELETE", "/api/billing/payment-methods/pm_primary2");

  assert.equal(res.status, 200);
  assert.equal(currentFakeStripe._state.cards.get("pm_backup2").metadata.priority, "primary");
  assert.equal(currentFakeStripe._state.defaultPaymentMethodId, "pm_backup2");
});

test("DELETE: 有効なサブスクリプションがある間、最後の1枚は削除できない（409）", async () => {
  const only = card("pm_only", "visa", "primary");
  currentFakeStripe = createFakeStripeAccount({ cards: [only], defaultPaymentMethodId: "pm_only" });
  TEST_CUSTOMER.stripeSubscriptionId = "sub_active_for_test";

  const res = await authedRequest("DELETE", "/api/billing/payment-methods/pm_only");

  assert.equal(res.status, 409);
  assert.equal(res.body.error, "last_card_with_active_subscription");
  assert.equal(currentFakeStripe._state.cards.size, 1, "実際には削除されていないこと");

  TEST_CUSTOMER.stripeSubscriptionId = null; // 後続テストへの影響を避ける
});

test("POST swap: primary/backupを入れ替え、default_payment_methodも新primaryに同期される", async () => {
  const primary = card("pm_swap_primary", "visa", "primary");
  const backup = card("pm_swap_backup", "mastercard", "backup");
  currentFakeStripe = createFakeStripeAccount({ cards: [primary, backup], defaultPaymentMethodId: "pm_swap_primary" });

  const res = await authedRequest("POST", "/api/billing/payment-methods/swap");

  assert.equal(res.status, 200);
  assert.equal(currentFakeStripe._state.cards.get("pm_swap_primary").metadata.priority, "backup");
  assert.equal(currentFakeStripe._state.cards.get("pm_swap_backup").metadata.priority, "primary");
  assert.equal(currentFakeStripe._state.defaultPaymentMethodId, "pm_swap_backup");
});

test("POST swap: カードが1枚しかない場合は400", async () => {
  const only = card("pm_swap_only", "visa", "primary");
  currentFakeStripe = createFakeStripeAccount({ cards: [only], defaultPaymentMethodId: "pm_swap_only" });

  const res = await authedRequest("POST", "/api/billing/payment-methods/swap");

  assert.equal(res.status, 400);
  assert.equal(res.body.error, "swap_requires_two_cards");
  assert.equal(currentFakeStripe._state.cards.get("pm_swap_only").metadata.priority, "primary", "変更されていないこと");
});
