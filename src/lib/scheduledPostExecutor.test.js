// attemptScheduledPost の「投稿成功時にtrialPostCountを加算するか」のリグレッションテスト。
// 継続スケジュール（post_schedules）由来の投稿（source_schedule_idあり）でのみ加算し、
// ワンショット予約投稿由来（source_schedule_idなし。posts.js側の作成時点で既に加算済み）は
// 二重加算しないことを検証する。SNS投稿API・microCMSへの実アクセスは行わず、依存モジュールを
// すべてフェイクに差し替える（billing.paymentMethods.test.jsと同じ「requireの前にexportを
// 差し替える」パターン。destructuringはrequire時点の値を固定で捕まえるため、
// scheduledPostExecutor.jsをrequireするより前に全モックを用意しておく必要がある）。
const test = require("node:test");
const assert = require("node:assert/strict");

const scheduledPostStore = require("./scheduledPostStore");
const postingLogStore = require("./postingLogStore");
const postingLogOriginStore = require("./postingLogOriginStore");
const tokenStore = require("./tokenStore");
const customerStore = require("./customerStore");
const meterEvents = require("./meterEvents");
const scheduleStore = require("./scheduleStore");
const scheduleResultMailer = require("./scheduleResultMailer");
const trialLimitAutoActivation = require("./trialLimitAutoActivation");
const xPoster = require("./xPoster");

scheduledPostStore.markScheduledPostStatus = async () => {};
postingLogStore.createPostingLog = async () => ({ id: "log_1" });
postingLogOriginStore.recordScheduledOrigin = () => {};
tokenStore.loadStore = () => ({ cust_1: { x: { access_token: "dummy" } } });
tokenStore.accountNameFor = () => "test-account";
meterEvents.reportMeterEvent = async () => {};
scheduleStore.getScheduleById = async () => ({ id: "sched_1", notify_email: false });
scheduleResultMailer.sendScheduleResultEmail = async () => true;
xPoster.postTextWithLinkImage = async () => ({ id: "post_x_1" });
// このテストファイルは trialPostCount の加算そのものが対象で、60通ラインを跨いだ際の
// 自動アクティベート・通知メール送信（trialLimitAutoActivation.js、実Stripe/実SMTP
// 呼び出しを含む）は別ファイル（trialLimitAutoActivation.test.js等）で検証済みのため、
// ここでは常にno-opにしてノーガードで実アクセスが走らないようにする（58→59→60と
// 跨ぐテストケースがあるため必須）。
trialLimitAutoActivation.activateAfterTrialLimitIfNeeded = async () => "no_payment_method";
trialLimitAutoActivation.sendTrialPostLimitReachedEmailIfNeeded = async () => false;

let currentCustomer = null;
let bumpCalls = [];
customerStore.getCustomerById = async () => currentCustomer;
customerStore.isCanceled = () => false;
customerStore.isTrialPostLimitReached = () => false;
customerStore.bumpTrialPostCount = async (customerId, currentCustomerArg, delta) => {
  bumpCalls.push({ customerId, delta });
  const next = (Number(currentCustomerArg.trialPostCount) || 0) + delta;
  return next;
};

const { attemptScheduledPost } = require("./scheduledPostExecutor");

function fakeLogger() {
  return { logError: () => {} };
}

test.beforeEach(() => {
  bumpCalls = [];
});

test("継続スケジュール由来（source_schedule_idあり）の投稿成功でtrialPostCountが加算される", async () => {
  currentCustomer = { id: "cust_1", trialPostCount: 10, status: ["trial"] };
  const customerCache = new Map();
  const post = {
    id: "post_1",
    platform: ["x"],
    customer_code: "cust_1",
    content: "hello",
    source_schedule_id: "sched_1",
  };

  await attemptScheduledPost(post, customerCache, fakeLogger());

  assert.equal(bumpCalls.length, 1);
  assert.deepEqual(bumpCalls[0], { customerId: "cust_1", delta: 1 });
  // 同一cron実行内での後続投稿判定用に、customerCache上のcustomerも更新される。
  assert.equal(customerCache.get("cust_1").trialPostCount, 11);
});

test("ワンショット予約投稿由来（source_schedule_idなし）は二重加算しない", async () => {
  currentCustomer = { id: "cust_1", trialPostCount: 10, status: ["trial"] };
  const customerCache = new Map();
  const post = {
    id: "post_2",
    platform: ["x"],
    customer_code: "cust_1",
    content: "hello",
    source_schedule_id: "",
  };

  await attemptScheduledPost(post, customerCache, fakeLogger());

  assert.equal(bumpCalls.length, 0);
  assert.equal(customerCache.get("cust_1").trialPostCount, 10);
});

test("同一cron実行内で同一顧客の複数投稿が古い値で重複加算されず正しく積み上がる", async () => {
  currentCustomer = { id: "cust_1", trialPostCount: 58, status: ["trial"] };
  const customerCache = new Map();
  const post1 = { id: "post_3", platform: ["x"], customer_code: "cust_1", content: "a", source_schedule_id: "sched_1" };
  const post2 = { id: "post_4", platform: ["x"], customer_code: "cust_1", content: "b", source_schedule_id: "sched_1" };

  await attemptScheduledPost(post1, customerCache, fakeLogger());
  await attemptScheduledPost(post2, customerCache, fakeLogger());

  assert.equal(bumpCalls.length, 2);
  assert.equal(bumpCalls[0].delta, 1);
  assert.equal(bumpCalls[1].delta, 1);
  assert.equal(customerCache.get("cust_1").trialPostCount, 60);
});

test("作成時は有効でも、実送信時に期限切れ・未払いなら投稿しない", async () => {
  currentCustomer = { id: "cust_1", trialPostCount: 10, status: ["trial"], trialEndsAt: "2000-01-01T00:00:00Z" };
  await assert.rejects(attemptScheduledPost({ id: "expired", customer_code: "cust_1", platform: ["x"], content: "test", notify_email: false }, new Map(), fakeLogger()), /payment_required/);
  assert.equal(bumpCalls.length, 0);
});

test("再登録後の未払いactive顧客も予約実行を拒否する", async () => {
  currentCustomer = { id: "cust_1", trialPostCount: 0, status: ["active"] };
  await assert.rejects(attemptScheduledPost({ id: "unpaid", customer_code: "cust_1", platform: ["x"], content: "test", notify_email: false }, new Map(), fakeLogger()), /payment_required/);
});
