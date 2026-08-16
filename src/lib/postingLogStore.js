// microCMS の posting_logs スキーマ（投稿実行ログ）への読み書き。
// customers.status/plan と同様、selectフィールドは配列で書き込み、
// 読み出し時はArray.isArrayで防御的に読む（customerStore.jsの既存慣習に合わせる）。
const { microcmsFetch } = require("./microcms");

// microCMSのselectフィールド側の有効値は小文字のキーそのもの（"X"等の大文字表示ラベルは
// 無効値としてエラーなく空配列に落とされるため注意。実測で確認済み）。
const PLATFORM_LABELS = { x: "x", threads: "threads", facebook: "facebook", instagram: "instagram" };

function toBillingPeriod(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function currentBillingPeriod() {
  const now = new Date();
  return toBillingPeriod(now.getFullYear(), now.getMonth() + 1);
}

/**
 * 投稿実行ログを1件作成する。
 * @param {string} customerCode microCMS顧客レコードid（req.customer.id）
 * @param {string} createdBy 投稿を実行したユーザーid（req.user.userId）
 * @param {string} platform "x" | "threads" | "facebook" | "instagram"
 */
async function createPostingLog({ customerCode, createdBy, platform, content, platformPostId, containsUrl, meterEventSent }) {
  const res = await microcmsFetch(`/posting_logs`, {
    method: "POST",
    body: JSON.stringify({
      customer_code: customerCode,
      created_by: createdBy,
      platform: [PLATFORM_LABELS[platform]],
      content: content || "",
      platform_post_id: platformPostId,
      posted_at: new Date().toISOString(),
      billing_period: currentBillingPeriod(),
      meter_event_sent: Boolean(meterEventSent),
      contains_url: Boolean(containsUrl),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[postingLogStore] createPostingLog failed ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

/** 指定顧客・指定請求対象月のログを全件取得する（ページング） */
async function listPostingLogsForCustomer(customerCode, billingPeriod) {
  const all = [];
  const limit = 100;
  let offset = 0;
  const filters = `customer_code[equals]${encodeURIComponent(customerCode)}[and]billing_period[equals]${encodeURIComponent(billingPeriod)}`;
  for (;;) {
    const res = await microcmsFetch(`/posting_logs?filters=${filters}&limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[postingLogStore] listPostingLogsForCustomer failed ${res.status} ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const contents = Array.isArray(json.contents) ? json.contents : [];
    all.push(...contents);
    if (contents.length < limit) break;
    offset += limit;
  }
  return all;
}

/** プラットフォームごとの投稿件数を集計する（該当なしは0） */
async function getPostStatsForCustomer(customerCode, year, month) {
  const billingPeriod = toBillingPeriod(year, month);
  const logs = await listPostingLogsForCustomer(customerCode, billingPeriod);
  const counts = { x: 0, threads: 0, facebook: 0, instagram: 0 };
  for (const log of logs) {
    const label = Array.isArray(log.platform) ? log.platform[0] : log.platform;
    const key = Object.keys(PLATFORM_LABELS).find((k) => PLATFORM_LABELS[k] === label);
    if (key) counts[key] += 1;
  }
  return counts;
}

module.exports = {
  PLATFORM_LABELS,
  createPostingLog,
  listPostingLogsForCustomer,
  getPostStatsForCustomer,
};
