// invoice.payment_failed Webhookハンドラ（handleInvoicePaymentFailed）のリグレッションテスト。
// 「同一event.idの再送で通知メールが二重送信される」不具合と、「既に支払い済みのinvoiceに
// 新しいevent.idで呼ばれても誤って運用アラートが飛ばない」ことを継続的に守るためのもの。
// Stripe/microCMS/SMTPへの実アクセスは行わず、全てフェイク/スパイに差し替える。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

// customerStore.getCustomerByStripeCustomerId・customerMailer.sendCustomerMail・
// mailer.notifyFailure は billing.js 側でモジュールの先頭で分割代入されているため、
// billing.js を require する「前」にエクスポート自体を差し替えておく必要がある
// （require後に差し替えても、billing.js内のローカル変数は差し替え前の関数を握ったまま）。
const customerMailer = require("../lib/customerMailer");
const mailer = require("../lib/mailer");
const customerStore = require("../lib/customerStore");

let mailCalls = [];
let notifyCalls = [];
let customerResolver = () => null;

customerMailer.sendCustomerMail = async (args) => {
  mailCalls.push(args);
  return { ok: true };
};
mailer.notifyFailure = async (subject, text) => {
  notifyCalls.push({ subject, text });
};
customerStore.getCustomerByStripeCustomerId = async (stripeCustomerId) => customerResolver(stripeCustomerId);

const billingRouter = require("./billing");
const { handleInvoicePaymentFailed, handleInvoicePaid } = billingRouter;

test.beforeEach(() => {
  mailCalls = [];
  notifyCalls = [];
  customerResolver = () => null;
});

// フェイクStripeクライアント。invoices.payのidempotencyKeyによる重複排除まで含めて、
// 実際のStripe挙動を最小限で模倣する（同一キーでの2回目呼び出しは課金せず、
// 前回と同じ結果をキャッシュから返す）。
function createFakeStripe({ cards, defaultPaymentMethodId, invoiceStatus, payOutcome = "succeed" }) {
  const invoice = { id: "in_test", status: invoiceStatus, metadata: {}, hosted_invoice_url: "https://stripe.test/invoice" };
  const usedIdempotencyKeys = new Map();
  let payCallCount = 0;

  return {
    _invoice: invoice,
    _payCallCount: () => payCallCount,
    invoices: {
      async retrieve(id) {
        assert.equal(id, invoice.id);
        return { ...invoice };
      },
      async update(id, { metadata }) {
        Object.assign(invoice.metadata, metadata);
        return { ...invoice };
      },
      async pay(id, { payment_method }, { idempotencyKey }) {
        if (usedIdempotencyKeys.has(idempotencyKey)) {
          return usedIdempotencyKeys.get(idempotencyKey);
        }
        payCallCount += 1;
        if (payOutcome === "card_declined") {
          const err = new Error("Your card was declined.");
          err.type = "StripeCardError";
          throw err;
        }
        if (payOutcome === "api_error") {
          const err = new Error("Stripe had an internal error.");
          err.type = "StripeAPIError";
          throw err;
        }
        invoice.status = "paid";
        const result = { ...invoice };
        usedIdempotencyKeys.set(idempotencyKey, result);
        return result;
      },
    },
    paymentMethods: {
      async list() {
        return { data: cards };
      },
    },
    customers: {
      async retrieve() {
        return { invoice_settings: { default_payment_method: defaultPaymentMethodId } };
      },
    },
  };
}

const backupCard = { id: "pm_backup", metadata: { priority: "backup" } };
const primaryCard = { id: "pm_primary", metadata: { priority: "primary" } };
const TEST_CUSTOMER = { id: "cust_internal", email: "test@example.com", stripeCustomerId: "cus_test" };

function useTestCustomer() {
  customerResolver = (stripeCustomerId) => (stripeCustomerId === TEST_CUSTOMER.stripeCustomerId ? TEST_CUSTOMER : null);
}

test("バックアップカードで決済成功 → 通知メールが1通送信される", async () => {
  useTestCustomer();
  const stripe = createFakeStripe({ cards: [primaryCard, backupCard], defaultPaymentMethodId: primaryCard.id, invoiceStatus: "open" });
  const event = { id: "evt_1", data: { object: { id: stripe._invoice.id, customer: TEST_CUSTOMER.stripeCustomerId } } };

  await handleInvoicePaymentFailed(stripe, event);

  assert.equal(stripe._payCallCount(), 1);
  assert.equal(mailCalls.length, 1);
  assert.equal(notifyCalls.length, 0);
  assert.equal(stripe._invoice.status, "paid");
  assert.equal(stripe._invoice.metadata.backup_retry_event_id, "evt_1");
});

test("同一event.idの再送（redelivery）→ 二重課金も通知メールの二重送信もしない（リグレッション対象）", async () => {
  useTestCustomer();
  const stripe = createFakeStripe({ cards: [primaryCard, backupCard], defaultPaymentMethodId: primaryCard.id, invoiceStatus: "open" });
  const event = { id: "evt_redelivery_test", data: { object: { id: stripe._invoice.id, customer: TEST_CUSTOMER.stripeCustomerId } } };

  await handleInvoicePaymentFailed(stripe, event);
  await handleInvoicePaymentFailed(stripe, event); // 同一event.idでの再送を模擬

  assert.equal(stripe._payCallCount(), 1, "invoices.payの実処理は1回だけ呼ばれること");
  assert.equal(mailCalls.length, 1, "通知メールは1通だけであること（二重送信されない）");
  assert.equal(notifyCalls.length, 0);
});

test("別のevent.idで、既に支払い済みのinvoiceに対して呼ばれた場合 → 何もせず、誤った運用アラートも飛ばさない（リグレッション対象）", async () => {
  useTestCustomer();
  const stripe = createFakeStripe({ cards: [primaryCard, backupCard], defaultPaymentMethodId: primaryCard.id, invoiceStatus: "open" });
  const event1 = { id: "evt_first", data: { object: { id: stripe._invoice.id, customer: TEST_CUSTOMER.stripeCustomerId } } };
  await handleInvoicePaymentFailed(stripe, event1); // ここでinvoiceがpaidになる

  const event2 = { id: "evt_completely_different", data: { object: { id: stripe._invoice.id, customer: TEST_CUSTOMER.stripeCustomerId } } };
  await handleInvoicePaymentFailed(stripe, event2);

  assert.equal(stripe._payCallCount(), 1, "支払い済みinvoiceに対してinvoices.payを再度呼んではいけない");
  assert.equal(mailCalls.length, 1, "追加の通知メールは送られない");
  assert.equal(notifyCalls.length, 0, "支払い済みは正常系のため運用アラートは不要");
});

test("バックアップカードが登録されていない → 何もせず終了（通常の督促に委ねる）", async () => {
  useTestCustomer();
  const stripe = createFakeStripe({ cards: [primaryCard], defaultPaymentMethodId: primaryCard.id, invoiceStatus: "open" });
  const event = { id: "evt_no_backup", data: { object: { id: stripe._invoice.id, customer: TEST_CUSTOMER.stripeCustomerId } } };

  await handleInvoicePaymentFailed(stripe, event);

  assert.equal(stripe._payCallCount(), 0);
  assert.equal(mailCalls.length, 0);
  assert.equal(notifyCalls.length, 0);
});

test("バックアップカードでの決済も失敗（カード拒否）→ 通常の督促に委ね、運用アラートは飛ばさない", async () => {
  useTestCustomer();
  const stripe = createFakeStripe({ cards: [primaryCard, backupCard], defaultPaymentMethodId: primaryCard.id, invoiceStatus: "open", payOutcome: "card_declined" });
  const event = { id: "evt_backup_declined", data: { object: { id: stripe._invoice.id, customer: TEST_CUSTOMER.stripeCustomerId } } };

  await handleInvoicePaymentFailed(stripe, event);

  assert.equal(mailCalls.length, 0);
  assert.equal(notifyCalls.length, 0, "カード拒否は想定内の失敗のため運用アラート不要");
});

test("バックアップカード決済でStripe側の予期しないエラー → 運用アラートを1件送る", async () => {
  useTestCustomer();
  const stripe = createFakeStripe({ cards: [primaryCard, backupCard], defaultPaymentMethodId: primaryCard.id, invoiceStatus: "open", payOutcome: "api_error" });
  const event = { id: "evt_backup_api_error", data: { object: { id: stripe._invoice.id, customer: TEST_CUSTOMER.stripeCustomerId } } };

  await handleInvoicePaymentFailed(stripe, event);

  assert.equal(mailCalls.length, 0);
  assert.equal(notifyCalls.length, 1, "想定外のStripe APIエラーは運用アラート対象");
});

test("stripeCustomerIdに一致する内部顧客が見つからない → 何もせず終了", async () => {
  // customerResolverはbeforeEachで「常にnullを返す」にリセット済み
  const stripe = createFakeStripe({ cards: [primaryCard, backupCard], defaultPaymentMethodId: primaryCard.id, invoiceStatus: "open" });
  const event = { id: "evt_unknown_customer", data: { object: { id: stripe._invoice.id, customer: "cus_totally_unknown" } } };

  await handleInvoicePaymentFailed(stripe, event);

  assert.equal(stripe._payCallCount(), 0);
  assert.equal(mailCalls.length, 0);
  assert.equal(notifyCalls.length, 0);
});

// handleInvoicePaid用の最小フェイクStripe（invoices.retrieve/updateのみ使う）。
function createFakeStripeForSuccess({ total = 3328, hostedInvoiceUrl = "https://stripe.test/invoice-paid" } = {}) {
  const invoice = { id: "in_success_test", total, hosted_invoice_url: hostedInvoiceUrl, metadata: {} };
  return {
    _invoice: invoice,
    invoices: {
      async retrieve(id) {
        assert.equal(id, invoice.id);
        return { ...invoice };
      },
      async update(id, { metadata }) {
        Object.assign(invoice.metadata, metadata);
        return { ...invoice };
      },
    },
  };
}

test("決済成功 → 請求金額の通知メールが1通送信される", async () => {
  useTestCustomer();
  const stripe = createFakeStripeForSuccess({ total: 3328 });
  const event = { id: "evt_success_1", data: { object: { id: stripe._invoice.id, customer: TEST_CUSTOMER.stripeCustomerId } } };

  await handleInvoicePaid(stripe, event);

  assert.equal(mailCalls.length, 1);
  assert.match(mailCalls[0].text, /3,328円/);
  assert.equal(stripe._invoice.metadata.payment_succeeded_notified_event_id, "evt_success_1");
});

test("決済成功通知の同一event.id再送 → 二重送信しない（リグレッション対象）", async () => {
  useTestCustomer();
  const stripe = createFakeStripeForSuccess();
  const event = { id: "evt_success_redelivery", data: { object: { id: stripe._invoice.id, customer: TEST_CUSTOMER.stripeCustomerId } } };

  await handleInvoicePaid(stripe, event);
  await handleInvoicePaid(stripe, event);

  assert.equal(mailCalls.length, 1, "通知メールは1通だけであること");
});

test("決済成功: stripeCustomerIdに一致する内部顧客が見つからない → 何もせず終了", async () => {
  const stripe = createFakeStripeForSuccess();
  const event = { id: "evt_success_unknown_customer", data: { object: { id: stripe._invoice.id, customer: "cus_totally_unknown" } } };

  await handleInvoicePaid(stripe, event);

  assert.equal(mailCalls.length, 0);
});
