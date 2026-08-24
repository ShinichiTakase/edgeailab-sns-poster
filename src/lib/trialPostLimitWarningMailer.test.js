// trialPostLimitWarningMailer.js のリグレッションテスト。
// 「支払い方法（Stripeカード）が登録済みなら送らない」「未登録なら送る」を検証する。
// Stripe・SMTPへの実アクセスは行わず、stripeClient・customerMailerをフェイクに差し替える
// （billing.paymentMethods.test.jsと同じ「requireの前にexportを差し替える」パターン）。
const test = require("node:test");
const assert = require("node:assert/strict");

const stripeClient = require("./stripeClient");
const customerMailer = require("./customerMailer");

let fakeCards = [];
stripeClient.getStripe = () => ({
  paymentMethods: {
    list: async () => ({ data: fakeCards }),
  },
});

let sentMails = [];
customerMailer.sendCustomerMail = async ({ toEmail, subject, text }) => {
  sentMails.push({ toEmail, subject, text });
  return { ok: true };
};

const { sendTrialPostLimitWarningIfNeeded, customerHasPaymentMethod } = require("./trialPostLimitWarningMailer");

test.beforeEach(() => {
  fakeCards = [];
  sentMails = [];
});

test("customerHasPaymentMethod: カード0枚ならfalse", async () => {
  fakeCards = [];
  assert.equal(await customerHasPaymentMethod("cus_1"), false);
});

test("customerHasPaymentMethod: カード1枚以上ならtrue", async () => {
  fakeCards = [{ id: "pm_1" }];
  assert.equal(await customerHasPaymentMethod("cus_1"), true);
});

test("customerHasPaymentMethod: stripeCustomerId未設定ならfalse（Stripeへ問い合わせない）", async () => {
  assert.equal(await customerHasPaymentMethod(""), false);
});

test("支払い方法未登録なら警告メールを送信する", async () => {
  fakeCards = [];
  const customer = { id: "cust_1", email: "a@example.com", stripeCustomerId: "cus_1", trialPostCount: 48, plan: ["Standard"] };
  const result = await sendTrialPostLimitWarningIfNeeded({ customer, logger: { logError: () => {} } });

  assert.equal(result, true);
  assert.equal(sentMails.length, 1);
  assert.equal(sentMails[0].toEmail, "a@example.com");
  assert.match(sentMails[0].text, /48通/);
});

test("支払い方法登録済みなら警告メールを送信しない", async () => {
  fakeCards = [{ id: "pm_1" }];
  const customer = { id: "cust_1", email: "a@example.com", stripeCustomerId: "cus_1", trialPostCount: 48, plan: ["Standard"] };
  const result = await sendTrialPostLimitWarningIfNeeded({ customer, logger: { logError: () => {} } });

  assert.equal(result, false);
  assert.equal(sentMails.length, 0);
});
