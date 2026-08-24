// requireUnderTrialPostLimit（requireAuth.js）のリグレッションテスト。
// 「投稿上限（60通）未満なら通す」「上限到達・支払い方法未登録なら403」
// 「上限到達だが支払い方法登録済みなら、その場で自動アクティベートしてから通す」を
// 検証する（trialLimitAutoActivation.jsの救済経路。billing.paymentMethods.test.jsと
// 同じ「requireの前にexportを差し替える」パターンで、Stripe・microCMSへの実アクセスは
// 行わない）。
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const customerStore = require("../lib/customerStore");
const stripeClient = require("../lib/stripeClient");
const stripePricing = require("../lib/stripePricing");
const { signSession, COOKIE_NAME } = require("../lib/jwt");

let currentCustomer = null;
customerStore.getCustomerById = async (id) => (id === currentCustomer.id ? currentCustomer : null);

let updatedCustomers = [];
customerStore.updateCustomer = async (id, patch) => {
  updatedCustomers.push({ id, patch });
};

let fakeCards = [];
stripeClient.getStripe = () => ({
  paymentMethods: { list: async () => ({ data: fakeCards }) },
  subscriptions: { create: async () => ({ id: "sub_new", status: "active" }) },
});

stripePricing.pricesForPlan = () => ({ base: "price_base", metered: "price_metered", meteredX: "price_metered_x" });
stripePricing.planKey = (customer) => {
  const value = Array.isArray(customer.plan) ? customer.plan[0] : customer.plan;
  return typeof value === "string" ? value.toLowerCase() : null;
};

const { requireAuth, requireUnderTrialPostLimit } = require("./requireAuth");

let server;
let baseUrl;

test.before(async () => {
  const app = express();
  app.get("/api/test/post", requireAuth, requireUnderTrialPostLimit, (req, res) => {
    res.json({ ok: true, status: req.customer.status });
  });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function authedGet() {
  const token = signSession(currentCustomer, currentCustomer.users[0]);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}/api/test/post`,
      { method: "GET", headers: { Cookie: `${COOKIE_NAME}=${token}` } },
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

test.beforeEach(() => {
  fakeCards = [];
  updatedCustomers = [];
});

test("投稿上限未満なら通す", async () => {
  currentCustomer = {
    id: "cust_1",
    plan: ["Standard"],
    status: ["trial"],
    trialPostCount: 10,
    users: [{ userId: "user_1", email: "a@example.com", role: ["管理者"], sessionVersion: 0 }],
  };
  const res = await authedGet();
  assert.equal(res.status, 200);
  assert.equal(updatedCustomers.length, 0);
});

test("上限到達・支払い方法未登録なら403で、自動アクティベートは行われない", async () => {
  fakeCards = [];
  currentCustomer = {
    id: "cust_1",
    plan: ["Standard"],
    status: ["trial"],
    trialPostCount: 60,
    users: [{ userId: "user_1", email: "a@example.com", role: ["管理者"], sessionVersion: 0 }],
  };
  const res = await authedGet();
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "trial_post_limit_reached");
  assert.equal(updatedCustomers.length, 0);
});

test("上限到達だが支払い方法登録済みなら、その場で自動アクティベートしてから通す", async () => {
  fakeCards = [{ id: "pm_1" }];
  currentCustomer = {
    id: "cust_1",
    plan: ["Standard"],
    status: ["trial"],
    trialPostCount: 60,
    stripeCustomerId: "cus_1",
    users: [{ userId: "user_1", email: "a@example.com", role: ["管理者"], sessionVersion: 0 }],
  };
  const res = await authedGet();
  assert.equal(res.status, 200);
  // ハンドラに渡る時点でreq.customer.statusが即座にactiveへ更新されていること
  assert.deepEqual(res.body.status, ["active"]);
  assert.equal(updatedCustomers.length, 1);
  assert.deepEqual(updatedCustomers[0].patch.status, ["active"]);
});
