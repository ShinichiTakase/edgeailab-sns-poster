// customerStore.crossedTrialPostLimitWarning / crossedTrialPostLimit のリグレッションテスト。
// トライアル投稿上限（60通）の80%（48通）、および60通そのものを「今回の加算で
// 初めて跨いだか」を正しく判定できるかを検証する（純粋関数のためモック不要）。
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  crossedTrialPostLimitWarning,
  crossedTrialPostLimit,
  TRIAL_POST_LIMIT_WARNING_COUNT,
  TRIAL_POST_LIMIT,
} = require("./customerStore");

test("TRIAL_POST_LIMIT_WARNING_COUNTは60通の80%=48", () => {
  assert.equal(TRIAL_POST_LIMIT_WARNING_COUNT, 48);
});

test("47->48（今回跨いだ）はtrue", () => {
  const customer = { status: ["trial"] };
  assert.equal(crossedTrialPostLimitWarning(customer, 47, 48), true);
});

test("48->49（既に跨いだ後）はfalse", () => {
  const customer = { status: ["trial"] };
  assert.equal(crossedTrialPostLimitWarning(customer, 48, 49), false);
});

test("45->50（複数件まとめて加算し一気に跨いだ）はtrue", () => {
  const customer = { status: ["trial"] };
  assert.equal(crossedTrialPostLimitWarning(customer, 45, 50), true);
});

test("47->47（delta<=0で変化なし）はfalse", () => {
  const customer = { status: ["trial"] };
  assert.equal(crossedTrialPostLimitWarning(customer, 47, 47), false);
});

test("トライアル中でない顧客（status=active）はfalse", () => {
  const customer = { status: ["active"] };
  assert.equal(crossedTrialPostLimitWarning(customer, 47, 48), false);
});

test("statusが配列でなく文字列の場合も判定できる", () => {
  const customer = { status: "trial" };
  assert.equal(crossedTrialPostLimitWarning(customer, 47, 48), true);
});

test("crossedTrialPostLimit: 59->60（今回跨いだ）はtrue", () => {
  const customer = { status: ["trial"] };
  assert.equal(crossedTrialPostLimit(customer, 59, TRIAL_POST_LIMIT), true);
});

test("crossedTrialPostLimit: 60->61（既に跨いだ後）はfalse", () => {
  const customer = { status: ["trial"] };
  assert.equal(crossedTrialPostLimit(customer, TRIAL_POST_LIMIT, 61), false);
});

test("crossedTrialPostLimit: 55->65（複数件まとめて加算し一気に跨いだ）はtrue", () => {
  const customer = { status: ["trial"] };
  assert.equal(crossedTrialPostLimit(customer, 55, 65), true);
});

test("crossedTrialPostLimit: トライアル中でない顧客（status=active）はfalse", () => {
  const customer = { status: ["active"] };
  assert.equal(crossedTrialPostLimit(customer, 59, 60), false);
});
