// posting_logsの各レコードが「即時投稿」由来か「予約投稿の実行結果」由来かをローカルJSONで
// 記録する（tokenStore.js/scheduledPostRetryStore.jsと同じファイルベースの暫定実装）。
// posting_logsのmicroCMSスキーマには対応フィールドがなく、追加には管理画面での手動スキーマ変更が
// 必要なため、投稿一覧画面（/api/posts/list）の「予定日時＝即時」判定にだけ使う軽量な補助データ。
const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "..", "..", "json", "posting_log_origins.json");

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) return {};
  const raw = fs.readFileSync(STORE_PATH, "utf-8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

// scheduledPostExecutor.jsが投稿成功時に呼ぶ。このposting_log idは予約投稿の実行結果であることを記録する。
function recordScheduledOrigin(postingLogId, scheduledPostId) {
  const store = loadStore();
  store[postingLogId] = { scheduledPostId };
  saveStore(store);
}

// posts.jsの/api/posts/listが使う。予約投稿の実行結果由来ならtrueを返す（＝即時投稿ではない）。
function isFromScheduledPost(postingLogId) {
  const store = loadStore();
  return Boolean(store[postingLogId]);
}

module.exports = { recordScheduledOrigin, isFromScheduledPost };

module.exports = require("../data/storeSelector").selectStore("postingLogOriginStore", module.exports);
