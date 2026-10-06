process.env.SNS_POSTER_DATA_SOURCE = "test-legacy";
// POST /api/sns-connections/:platform/disconnect のリグレッションテスト。
// 「連携解除しても、そのプラットフォーム宛ての未実行予約投稿（scheduled_posts,
// status=pending）が残ったままになる」不具合の修正を継続的に守るためのもの。
// microCMS/実ファイルへの実アクセスは行わず、tokenStore・scheduledPostStore・
// customerStoreをすべてフェイクに差し替えた軽量な統合テスト（billing.paymentMethods.test.js
// と同じパターン）。
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const customerStore = require("../lib/customerStore");
const tokenStore = require("../lib/tokenStore");
const scheduledPostStore = require("../lib/scheduledPostStore");
const { signSession } = require("../lib/jwt");
const { COOKIE_NAME } = require("../lib/jwt");

const TEST_CUSTOMER = {
  id: "cust_sns_disconnect_test",
  email: "test@example.com",
  users: [{ userId: "user_1", email: "test@example.com", role: ["管理者"], sessionVersion: 0 }],
};
const VIEWER_CUSTOMER = {
  id: "cust_sns_disconnect_viewer",
  email: "viewer@example.com",
  users: [{ userId: "user_2", email: "viewer@example.com", role: ["閲覧者"], sessionVersion: 0 }],
};

customerStore.getCustomerById = async (id) => {
  if (id === TEST_CUSTOMER.id) return TEST_CUSTOMER;
  if (id === VIEWER_CUSTOMER.id) return VIEWER_CUSTOMER;
  return null;
};

// tokenStoreはファイル(json/client_tokens.json)を直接読み書きするため、
// テストでは接続状況をメモリ上のMapに差し替える。
let connectedState = new Map(); // key: `${slug}:${platform}` -> tokenEntry
tokenStore.getConnectedEntry = (slug) => {
  const entry = {};
  for (const [key, value] of connectedState) {
    const [entrySlug, platform] = key.split(":");
    if (entrySlug === slug) entry[platform] = value;
  }
  return entry;
};
tokenStore.deletePlatformTokensBySlug = (slug, platform) => {
  const key = `${slug}:${platform}`;
  if (!connectedState.has(key)) return false;
  connectedState.delete(key);
  return true;
};
tokenStore.accountNameFor = () => "test-account";

// scheduledPostStoreも同様にメモリ上の配列に差し替え、削除呼び出しを記録する。
let pendingPostsByKey = new Map(); // key: `${customerCode}:${platform}` -> [{id}, ...]
const deletedIds = [];
scheduledPostStore.listPendingByCustomerAndPlatform = async (customerCode, platform) =>
  pendingPostsByKey.get(`${customerCode}:${platform}`) || [];
scheduledPostStore.deleteScheduledPost = async (id) => {
  deletedIds.push(id);
};

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

function authedPost(customer, path) {
  const token = signSession(customer, customer.users[0]);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      { method: "POST", headers: { Cookie: `${COOKIE_NAME}=${token}` } },
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
  connectedState = new Map();
  pendingPostsByKey = new Map();
  deletedIds.length = 0;
});

test("連携解除時に、そのプラットフォーム宛ての未実行予約が全件キャンセルされる", async () => {
  connectedState.set(`${TEST_CUSTOMER.id}:x`, { accessToken: "dummy" });
  pendingPostsByKey.set(`${TEST_CUSTOMER.id}:x`, [{ id: "post_1" }, { id: "post_2" }]);

  const res = await authedPost(TEST_CUSTOMER, "/api/sns-connections/x/disconnect");

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.canceledScheduledPostCount, 2);
  assert.deepEqual(deletedIds, ["post_1", "post_2"]);
  assert.equal(connectedState.has(`${TEST_CUSTOMER.id}:x`), false);
});

test("他プラットフォームの未実行予約には影響しない", async () => {
  connectedState.set(`${TEST_CUSTOMER.id}:threads`, { accessToken: "dummy" });
  pendingPostsByKey.set(`${TEST_CUSTOMER.id}:threads`, [{ id: "post_threads_1" }]);
  pendingPostsByKey.set(`${TEST_CUSTOMER.id}:x`, [{ id: "post_x_1" }]);

  const res = await authedPost(TEST_CUSTOMER, "/api/sns-connections/threads/disconnect");

  assert.equal(res.status, 200);
  assert.equal(res.body.canceledScheduledPostCount, 1);
  assert.deepEqual(deletedIds, ["post_threads_1"]);
});

test("未連携のプラットフォームを解除しようとすると404で、予約キャンセルも行われない", async () => {
  pendingPostsByKey.set(`${TEST_CUSTOMER.id}:instagram`, [{ id: "post_should_not_be_touched" }]);

  const res = await authedPost(TEST_CUSTOMER, "/api/sns-connections/instagram/disconnect");

  assert.equal(res.status, 404);
  assert.equal(res.body.error, "not_connected");
  assert.deepEqual(deletedIds, []);
});

test("該当プラットフォーム宛ての未実行予約が0件でも200で完了する", async () => {
  connectedState.set(`${TEST_CUSTOMER.id}:facebook`, { accessToken: "dummy" });

  const res = await authedPost(TEST_CUSTOMER, "/api/sns-connections/facebook/disconnect");

  assert.equal(res.status, 200);
  assert.equal(res.body.canceledScheduledPostCount, 0);
  assert.deepEqual(deletedIds, []);
});

test("閲覧者ロールは連携解除できない（403）", async () => {
  connectedState.set(`${VIEWER_CUSTOMER.id}:x`, { accessToken: "dummy" });
  pendingPostsByKey.set(`${VIEWER_CUSTOMER.id}:x`, [{ id: "post_viewer_1" }]);

  const res = await authedPost(VIEWER_CUSTOMER, "/api/sns-connections/x/disconnect");

  assert.equal(res.status, 403);
  assert.deepEqual(deletedIds, []);
  assert.equal(connectedState.has(`${VIEWER_CUSTOMER.id}:x`), true);
});
