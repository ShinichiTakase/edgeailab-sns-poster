process.env.SNS_POSTER_DATA_SOURCE = "test-legacy";
// POST /api/sns-connections/confirm-trial-history-reconnect のリグレッションテスト。
// SNS連携履歴（sns_history.json）ヒット時の確認ダイアログ「連携」を確定する
// エンドポイント（2026-09-01追加、トライアル濫用防止）。
// microCMS/実ファイルへの実アクセスは行わず、customerStore・tokenStore・
// snsHistoryStoreをすべてフェイクに差し替えた統合テスト（既存の
// snsConnections.test.jsと同じパターン）。pkceStoreのみ実物を使い、
// テスト側でpkceStore.put()により保留状態を直接セットアップする。
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const customerStore = require("../lib/customerStore");
const tokenStore = require("../lib/tokenStore");
const snsHistoryStore = require("../lib/snsHistoryStore");
const pkceStore = require("../lib/pkceStore");
const { signSession, COOKIE_NAME } = require("../lib/jwt");

const TEST_CUSTOMER = {
  id: "cust_trial_history_reconnect_test",
  email: "trial-history@example.com",
  users: [{ userId: "user_1", email: "trial-history@example.com", role: ["管理者"], sessionVersion: 0 }],
};

customerStore.getCustomerById = async (id) => (id === TEST_CUSTOMER.id ? TEST_CUSTOMER : null);

const updateCustomerCalls = [];
customerStore.updateCustomer = async (id, patch) => {
  updateCustomerCalls.push({ id, patch });
  return true;
};

// getConnectedEntryは「現在instagramに連携中のアカウント」の有無をInstagramの
// アカウント切替判定（confirm-trial-history-reconnect内）で使う。
let connectedInstagramEntry = null;
tokenStore.getConnectedEntry = (slug) => (slug === TEST_CUSTOMER.id && connectedInstagramEntry ? { instagram: connectedInstagramEntry } : {});

const savedTokenCalls = [];
tokenStore.savePlatformTokens = (slug, platform, data) => {
  savedTokenCalls.push({ slug, platform, data });
  return data;
};

const recordedHistoryCalls = [];
snsHistoryStore.recordNewIdentifiers = (platform, identifiers, customerId, connectedAt) => {
  recordedHistoryCalls.push({ platform, identifiers, customerId, connectedAt });
};

// snsConnections.js（trialHistoryGuard.js経由でcustomerStore/snsHistoryStoreを
// requireする）は、上記のモック差し替えが完了した後に初めてrequireすること
// （requireキャッシュ経由でモック済みのモジュールオブジェクトを参照させるため）。
const snsConnectionsRouter = require("./snsConnections");

let server;
let baseUrl;

test.before(async () => {
  const app = express();
  app.use(snsConnectionsRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
});

function authedPostJson(customer, apiPath, body) {
  const token = signSession(customer, customer.users[0]);
  const payload = JSON.stringify(body || {});
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${apiPath}`,
      {
        method: "POST",
        headers: {
          Cookie: `${COOKIE_NAME}=${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (c) => (responseBody += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(responseBody || "{}") }));
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

test.beforeEach(() => {
  connectedInstagramEntry = null;
  savedTokenCalls.length = 0;
  recordedHistoryCalls.length = 0;
  updateCustomerCalls.length = 0;
});

test("tokenが無ければ400 token_required（express.json()未適用によるreq.body欠落のリグレッション防止）", async () => {
  const res = await authedPostJson(TEST_CUSTOMER, "/api/sns-connections/confirm-trial-history-reconnect", {});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "token_required");
});

test("無効・期限切れのtokenは400 invalid_or_expired_token", async () => {
  const res = await authedPostJson(TEST_CUSTOMER, "/api/sns-connections/confirm-trial-history-reconnect", {
    token: "not-a-real-token",
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "invalid_or_expired_token");
});

test("X等（Instagram以外）: トークン保存・トライアル失効・履歴記録が同時に行われる", async () => {
  const token = "history-token-x";
  pkceStore.put(token, {
    slug: TEST_CUSTOMER.id,
    platform: "x",
    tokenData: { user_id: "999", username: "reused_account" },
    identifiers: ["999"],
  });

  const res = await authedPostJson(TEST_CUSTOMER, "/api/sns-connections/confirm-trial-history-reconnect", { token });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.needsSwitchConfirm, undefined);

  assert.equal(savedTokenCalls.length, 1);
  assert.equal(savedTokenCalls[0].slug, TEST_CUSTOMER.id);
  assert.equal(savedTokenCalls[0].platform, "x");

  assert.equal(updateCustomerCalls.length, 1);
  assert.equal(updateCustomerCalls[0].id, TEST_CUSTOMER.id);
  assert.deepEqual(updateCustomerCalls[0].patch, { status: ["active"], trialEndsAt: "" });

  assert.equal(recordedHistoryCalls.length, 1);
  assert.deepEqual(recordedHistoryCalls[0].identifiers, ["999"]);
});

test("同じtokenは一度しか使えない（pkceStore.takeによる使い捨て）", async () => {
  const token = "history-token-one-shot";
  pkceStore.put(token, {
    slug: TEST_CUSTOMER.id,
    platform: "threads",
    tokenData: { user_id: "111", username: "acct" },
    identifiers: ["111"],
  });

  const first = await authedPostJson(TEST_CUSTOMER, "/api/sns-connections/confirm-trial-history-reconnect", { token });
  assert.equal(first.status, 200);

  const second = await authedPostJson(TEST_CUSTOMER, "/api/sns-connections/confirm-trial-history-reconnect", { token });
  assert.equal(second.status, 400);
  assert.equal(second.body.error, "invalid_or_expired_token");
});

test("Instagramで現在の連携先と異なるアカウントへの切替が必要な場合、保存・トライアル失効を行わずswitchTokenを返す", async () => {
  connectedInstagramEntry = { user_id: "old_account_id", username: "old_account" };

  const token = "history-token-instagram-switch";
  pkceStore.put(token, {
    slug: TEST_CUSTOMER.id,
    platform: "instagram",
    tokenData: { user_id: "new_account_id", username: "new_account" },
    identifiers: ["new_account_id"],
  });

  const res = await authedPostJson(TEST_CUSTOMER, "/api/sns-connections/confirm-trial-history-reconnect", { token });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.needsSwitchConfirm, true);
  assert.equal(typeof res.body.switchToken, "string");
  assert.equal(res.body.from, "old_account");
  assert.equal(res.body.to, "new_account");

  // ここではまだ何も確定していない（切替確認を経て初めて確定する）。
  assert.equal(savedTokenCalls.length, 0);
  assert.equal(updateCustomerCalls.length, 0);
  assert.equal(recordedHistoryCalls.length, 0);
});

test("Instagramで現在連携中のアカウントと同一（または未連携）の場合は即座に確定する", async () => {
  connectedInstagramEntry = null; // 未連携

  const token = "history-token-instagram-direct";
  pkceStore.put(token, {
    slug: TEST_CUSTOMER.id,
    platform: "instagram",
    tokenData: { user_id: "same_account_id", username: "same_account" },
    identifiers: ["same_account_id"],
  });

  const res = await authedPostJson(TEST_CUSTOMER, "/api/sns-connections/confirm-trial-history-reconnect", { token });

  assert.equal(res.status, 200);
  assert.equal(res.body.needsSwitchConfirm, undefined);
  assert.equal(savedTokenCalls.length, 1);
  assert.equal(updateCustomerCalls.length, 1);
  assert.equal(recordedHistoryCalls.length, 1);
});

test("自分以外のcustomerId宛てに発行されたtokenでは確定できない", async () => {
  const token = "history-token-other-customer";
  pkceStore.put(token, {
    slug: "someone_elses_customer_id",
    platform: "x",
    tokenData: { user_id: "999", username: "acct" },
    identifiers: ["999"],
  });

  const res = await authedPostJson(TEST_CUSTOMER, "/api/sns-connections/confirm-trial-history-reconnect", { token });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, "invalid_or_expired_token");
  assert.equal(savedTokenCalls.length, 0);
});
