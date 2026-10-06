// 予約投稿の再試行回数をjson/scheduled_post_retries.jsonで管理する（tokenStore.jsと同じ
// ファイルベースの暫定実装）。microCMSのscheduled_posts.statusはpending/done/failedの3値のみ
// （選択肢の追加はmicroCMS管理画面での手動スキーマ変更が必要なため、再試行の進行状況は
// ここで別管理し、投稿一覧画面の「結果」列は status=failed とこの件数を組み合わせて
// 「再試行」（まだ再試行の余地あり）/「失敗」（打ち止め）を判定する）。
const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "..", "..", "json", "scheduled_post_retries.json");
const MAX_RETRIES = 3;
const RETRY_INTERVAL_MS = 3 * 60 * 1000;

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) return {};
  const raw = fs.readFileSync(STORE_PATH, "utf-8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

function getRetryInfo(postId) {
  const store = loadStore();
  return store[postId] || null;
}

// 初回投稿（scheduledPostRunner.js）が失敗した直後に呼ぶ。3分後を次回再試行時刻として記録する。
function recordInitialFailure(postId) {
  const store = loadStore();
  store[postId] = { retryCount: 0, nextRetryAt: new Date(Date.now() + RETRY_INTERVAL_MS).toISOString() };
  saveStore(store);
}

// 再試行（scheduledPostRetryRunner.js）が失敗した直後に呼ぶ。上限(MAX_RETRIES)に達したら
// nextRetryAtをnullにして以降拾われないようにする。
function recordRetryFailure(postId) {
  const store = loadStore();
  const entry = store[postId] || { retryCount: 0, nextRetryAt: null };
  entry.retryCount += 1;
  entry.nextRetryAt = entry.retryCount < MAX_RETRIES ? new Date(Date.now() + RETRY_INTERVAL_MS).toISOString() : null;
  store[postId] = entry;
  saveStore(store);
  return entry;
}

// 投稿成功時に呼ぶ。再試行管理から除外する。
function clearRetry(postId) {
  const store = loadStore();
  if (store[postId]) {
    delete store[postId];
    saveStore(store);
  }
}

// 再試行対象（=記録があり、上限未満で、次回再試行時刻に達している）かどうかを判定する。
function isDueForRetry(postId) {
  const entry = getRetryInfo(postId);
  if (!entry) return false;
  if (entry.retryCount >= MAX_RETRIES) return false;
  if (!entry.nextRetryAt) return false;
  return new Date(entry.nextRetryAt).getTime() <= Date.now();
}

// 投稿一覧画面の「結果」列表示用。記録がない、または上限到達済みなら「失敗」（打ち止め）、
// 記録があり上限未満なら「再試行」（今後も再試行される見込み）とする。
function getDisplayState(postId) {
  const entry = getRetryInfo(postId);
  if (!entry) return "failed";
  return entry.retryCount < MAX_RETRIES ? "retrying" : "failed";
}

module.exports = {
  MAX_RETRIES,
  RETRY_INTERVAL_MS,
  getRetryInfo,
  recordInitialFailure,
  recordRetryFailure,
  clearRetry,
  isDueForRetry,
  getDisplayState,
};

module.exports = require("../data/storeSelector").selectStore("scheduledPostRetryStore", module.exports);
