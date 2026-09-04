// 顧客向け「お知らせ」を管理する。当面は投稿失敗のみを対象とする想定で、件数も
// 少なく専用のmicroCMSスキーマを追加するほどではないため、client_tokens.json・
// scheduled_post_retries.json等と同じくJSONファイルベースの暫定実装とする。
// 既読管理は「未読件数は表示しない」仕様のため、既読済みID集合を持つ必要はなく、
// ユーザーごとの最終既読日時（announcement_reads.json）と対象顧客の最新お知らせの
// createdAtを比較するだけで足りる。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORE_PATH = path.join(__dirname, "..", "..", "json", "announcements.json");
const READS_PATH = path.join(__dirname, "..", "..", "json", "announcement_reads.json");

// 1顧客あたりの保持上限。今後発生するものだけを対象とする機能のため、過去に
// 遡っての一括表示は想定していない（古いものから切り捨てる）。
const MAX_PER_CUSTOMER = 200;

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function loadAnnouncements() {
  return loadJson(STORE_PATH) || [];
}

function loadReads() {
  return loadJson(READS_PATH) || {};
}

/** お知らせを1件追加する。typeは将来の拡張用（当面 "post_failure" のみ発生）。 */
function createAnnouncement({ customerCode, type, title, body }) {
  const list = loadAnnouncements();
  list.push({
    id: `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
    customerCode,
    type,
    title,
    body,
    createdAt: new Date().toISOString(),
  });

  const forCustomerIds = list.filter((a) => a.customerCode === customerCode).map((a) => a.id);
  if (forCustomerIds.length > MAX_PER_CUSTOMER) {
    const dropIds = new Set(forCustomerIds.slice(0, forCustomerIds.length - MAX_PER_CUSTOMER));
    saveJson(STORE_PATH, list.filter((a) => !dropIds.has(a.id)));
  } else {
    saveJson(STORE_PATH, list);
  }
}

/** 指定顧客のお知らせを新しい順に返す。 */
function listForCustomer(customerCode) {
  return loadAnnouncements()
    .filter((a) => a.customerCode === customerCode)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/** 指定ユーザーにとって未読のお知らせがあるか（顧客内の最新お知らせ基準）。 */
function hasUnread(customerCode, userId) {
  const list = listForCustomer(customerCode);
  if (list.length === 0) return false;
  const lastReadAt = loadReads()[userId];
  if (!lastReadAt) return true;
  return new Date(list[0].createdAt).getTime() > new Date(lastReadAt).getTime();
}

/** お知らせ一覧画面を開いたユーザーの既読日時を現在時刻に更新する。 */
function markRead(userId) {
  const reads = loadReads();
  reads[userId] = new Date().toISOString();
  saveJson(READS_PATH, reads);
}

module.exports = { createAnnouncement, listForCustomer, hasUnread, markRead };
