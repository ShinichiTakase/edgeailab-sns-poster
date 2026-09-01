// trialHistoryGuard.checkTrialHistoryHit の判定ロジック（適用条件のゲート）のテスト。
// SNS連携履歴によるトライアル濫用防止（2026-09-01追加）の中核判定。
// customerStore・snsConnectionModeConfig・snsHistoryStoreをフェイクに差し替える。
// destructuring importのため、モックは trialHistoryGuard.js の require より前に
// 適用する必要がある（snsConnections.trialHistoryReconnect.test.jsと同じ注意点）。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const customerStore = require("./customerStore");
const snsConnectionModeConfig = require("./snsConnectionModeConfig");
const snsHistoryStore = require("./snsHistoryStore");

const TRIAL_CUSTOMER = { id: "cust_trial", status: ["trial"] };
const ACTIVE_CUSTOMER = { id: "cust_active", status: ["active"] };
const TEST_SLUG_CUSTOMER = { id: "cust_test_slug", status: ["trial"] };

customerStore.getCustomerById = async (id) => {
  if (id === TRIAL_CUSTOMER.id) return TRIAL_CUSTOMER;
  if (id === ACTIVE_CUSTOMER.id) return ACTIVE_CUSTOMER;
  if (id === TEST_SLUG_CUSTOMER.id) return TEST_SLUG_CUSTOMER;
  return null;
};

snsConnectionModeConfig.isKnownTestSlug = (customerId) => customerId === TEST_SLUG_CUSTOMER.id;

const HIT = { key: "x:999", identifier: "999", firstCustomerId: "someone_else", firstConnectedAt: "2026-08-01T00:00:00.000Z" };
snsHistoryStore.findOtherCustomerHit = () => HIT;

const { checkTrialHistoryHit } = require("./trialHistoryGuard");

test("トライアル中の顧客が他顧客の履歴にヒットした場合、ヒット情報を返す", async () => {
  const hit = await checkTrialHistoryHit("x", ["999"], TRIAL_CUSTOMER.id);
  assert.deepEqual(hit, HIT);
});

test("課金中（status!==trial）の顧客はヒットしていても対象外（nullを返す）", async () => {
  const hit = await checkTrialHistoryHit("x", ["999"], ACTIVE_CUSTOMER.id);
  assert.equal(hit, null);
});

test("検証用テストアカウント（isKnownTestSlug）はトライアル中でも対象外（nullを返す）", async () => {
  const hit = await checkTrialHistoryHit("x", ["999"], TEST_SLUG_CUSTOMER.id);
  assert.equal(hit, null);
});

test("customerが存在しない場合はnullを返す（例外を投げない）", async () => {
  const hit = await checkTrialHistoryHit("x", ["999"], "nonexistent_customer_id");
  assert.equal(hit, null);
});
