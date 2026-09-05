// microCMS の posting_logs スキーマ（投稿実行ログ）への読み書き。
// customers.status/plan と同様、selectフィールドは配列で書き込み、
// 読み出し時はArray.isArrayで防御的に読む（customerStore.jsの既存慣習に合わせる）。
const { microcmsFetch } = require("./microcms");

// microCMSのselectフィールド側の有効値は小文字のキーそのもの（"X"等の大文字表示ラベルは
// 無効値としてエラーなく空配列に落とされるため注意。実測で確認済み）。
const PLATFORM_LABELS = { x: "x", threads: "threads", facebook: "facebook", instagram: "instagram", linkedin: "linkedin" };

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
async function createPostingLog({ customerCode, createdBy, platform, content, platformPostId, containsUrl, meterEventSent, accountName }) {
  const body = {
    customer_code: customerCode,
    created_by: createdBy,
    platform: [PLATFORM_LABELS[platform]],
    content: content || "",
    platform_post_id: platformPostId,
    posted_at: new Date().toISOString(),
    billing_period: currentBillingPeriod(),
    meter_event_sent: Boolean(meterEventSent),
    contains_url: Boolean(containsUrl),
    // 投稿時点で実際にトークンが紐づいていたSNSアカウント名（例: Instagramのusername）。
    // 「連携し直したら別アカウントに投稿されていた」事故（2026-08-21）の再発時に、
    // どのアカウントに投稿されたかを事後追跡できるようにするため。
    account_name: accountName || "",
  };
  let res = await microcmsFetch(`/posting_logs`, { method: "POST", body: JSON.stringify(body) });

  // account_nameフィールドがmicroCMS側のposting_logsスキーマにまだ追加されていない環境
  // （手動でのスキーマ追加が必要、2026-08-22時点で未実施）では、このフィールドを含めた
  // 書き込みが400で拒否され、ログ自体が一切記録できなくなってしまう。投稿ログの記録は
  // 投稿成否そのものより優先度が低いため、フィールド未対応が原因の場合はこのフィールドを
  // 落として再送し、記録自体は失わないようにする（フィールド追加後は自動的に記録されるようになる）。
  if (!res.ok && res.status === 400) {
    const text = await res.text().catch(() => "");
    if (text.includes("account_name")) {
      console.warn("[postingLogStore] account_name field not present in microCMS schema yet; retrying without it");
      const { account_name, ...bodyWithoutAccountName } = body;
      res = await microcmsFetch(`/posting_logs`, { method: "POST", body: JSON.stringify(bodyWithoutAccountName) });
    }
  }

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

/**
 * 指定顧客の投稿ログを、投稿日時（posted_at）の範囲で取得する（ページング）。
 * billing_period（歴月単位）ではなく実際の日時で絞り込む。請求予測・投稿予定の
 * 「実績（今日まで）」集計専用（billingCycle.js参照）。
 */
async function listPostingLogsForCustomerInRange(customerCode, startDate, endDate) {
  const all = [];
  const limit = 100;
  let offset = 0;
  const filters = [
    `customer_code[equals]${encodeURIComponent(customerCode)}`,
    `posted_at[greater_than]${encodeURIComponent(startDate.toISOString())}`,
    `posted_at[less_than]${encodeURIComponent(endDate.toISOString())}`,
  ].join("[and]");
  for (;;) {
    const res = await microcmsFetch(`/posting_logs?filters=${filters}&limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[postingLogStore] listPostingLogsForCustomerInRange failed ${res.status} ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const contents = Array.isArray(json.contents) ? json.contents : [];
    all.push(...contents);
    if (contents.length < limit) break;
    offset += limit;
  }
  return all;
}

/** 指定期間内の実行済み投稿を、scheduledPostStore.getScheduledPostsSummaryと同じ形式
 * （counts/xUrlCount/totalCount）で集計する。 */
async function getActualPostCounts(customerCode, startDate, endDate) {
  const logs = await listPostingLogsForCustomerInRange(customerCode, startDate, endDate);
  const counts = { x: 0, threads: 0, facebook: 0, instagram: 0, linkedin: 0 };
  let xUrlCount = 0;
  for (const log of logs) {
    const label = Array.isArray(log.platform) ? log.platform[0] : log.platform;
    const key = Object.keys(PLATFORM_LABELS).find((k) => PLATFORM_LABELS[k] === label);
    if (!key) continue;
    counts[key] += 1;
    if (key === "x" && log.contains_url) xUrlCount += 1;
  }
  const totalCount = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { counts, xUrlCount, totalCount };
}

/** 指定顧客の全期間のログを全件取得する（投稿一覧画面用。ページング） */
async function listAllPostingLogsForCustomer(customerCode) {
  const all = [];
  const limit = 100;
  let offset = 0;
  const filters = `customer_code[equals]${encodeURIComponent(customerCode)}`;
  for (;;) {
    const res = await microcmsFetch(`/posting_logs?filters=${filters}&limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[postingLogStore] listAllPostingLogsForCustomer failed ${res.status} ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const contents = Array.isArray(json.contents) ? json.contents : [];
    all.push(...contents);
    if (contents.length < limit) break;
    offset += limit;
  }
  return all;
}

/**
 * 全顧客横断で投稿ログを全件取得する（管理者ダッシュボード「投稿一覧」用。ページング）。
 * 顧客数・投稿数が増えると重くなる（全件フェッチ）点はlistAllPostingLogsForCustomerと
 * 同じ制約。将来的に問題になるようであれば、管理者ダッシュボードの他の一覧と同様に
 * バッチキャッシュ化を検討すること。
 */
async function listAllPostingLogsAcrossCustomers() {
  const all = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    const res = await microcmsFetch(`/posting_logs?orders=-posted_at&limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[postingLogStore] listAllPostingLogsAcrossCustomers failed ${res.status} ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const contents = Array.isArray(json.contents) ? json.contents : [];
    all.push(...contents);
    if (contents.length < limit) break;
    offset += limit;
  }
  return all;
}

async function deletePostingLog(id) {
  const res = await microcmsFetch(`/posting_logs/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`[postingLogStore] deletePostingLog failed ${res.status} ${text.slice(0, 300)}`);
  }
}

/** プラットフォームごとの投稿件数を集計する（該当なしは0） */
async function getPostStatsForCustomer(customerCode, year, month) {
  const billingPeriod = toBillingPeriod(year, month);
  const logs = await listPostingLogsForCustomer(customerCode, billingPeriod);
  const counts = { x: 0, threads: 0, facebook: 0, instagram: 0, linkedin: 0 };
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
  listPostingLogsForCustomerInRange,
  listAllPostingLogsForCustomer,
  listAllPostingLogsAcrossCustomers,
  deletePostingLog,
  getPostStatsForCustomer,
  getActualPostCounts,
};
