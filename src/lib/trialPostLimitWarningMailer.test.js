// trialPostLimitWarningMailer.js のリグレッションテスト。
// 支払い方法（Stripeカード）の登録有無に関わらずメールは送信されるが、本文の
// 案内内容が出し分けられることを検証する（2026-08-25変更: 以前は登録済みなら
// 送信自体をスキップしていたが、60通到達時に登録済みなら自動課金する仕様になった
// ため、登録済み向けにも「自動課金される」旨を案内する必要がある）。
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

test("支払い方法未登録: 送信され、投稿停止・登録案内の文面になる", async () => {
  fakeCards = [];
  const customer = { id: "cust_1", email: "a@example.com", stripeCustomerId: "cus_1", trialPostCount: 48, plan: ["Standard"] };
  const result = await sendTrialPostLimitWarningIfNeeded({ customer, logger: { logError: () => {} } });

  assert.equal(result, true);
  assert.equal(sentMails.length, 1);
  assert.equal(sentMails[0].toEmail, "a@example.com");
  assert.match(sentMails[0].text, /48通/);
  assert.match(sentMails[0].text, /投稿ができなくなります/);
  assert.match(sentMails[0].text, /payment\.html/);
});

test("支払い方法登録済み: 送信され、自動課金される旨の文面になる（送信自体はスキップしない）", async () => {
  fakeCards = [{ id: "pm_1" }];
  const customer = { id: "cust_1", email: "a@example.com", stripeCustomerId: "cus_1", trialPostCount: 48, plan: ["Standard"] };
  const result = await sendTrialPostLimitWarningIfNeeded({ customer, logger: { logError: () => {} } });

  assert.equal(result, true);
  assert.equal(sentMails.length, 1);
  assert.match(sentMails[0].text, /自動的に基本料金のご請求が開始/);
  assert.doesNotMatch(sentMails[0].text, /payment\.html/);
});
