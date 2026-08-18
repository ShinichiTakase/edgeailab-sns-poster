// microCMS の scheduled_posts スキーマ（予約投稿）へのアクセス。
// 予約の作成（ワンショット投稿ウィザードの「予約」）と、予定件数・請求予測表示用の
// 集計読み取りの両方をここで扱う。実際に予約を投稿として実行するcronはまだ存在しない。
// postingLogStore.jsと同様、selectフィールドは配列で書き込み・読み取りする
// （Array.isArrayで防御的に読む）。
const { microcmsFetch } = require("./microcms");

// microCMSのselectフィールド側の有効値は小文字のキーそのもの（"X"等の大文字表示ラベルは
// 無効値としてエラーなく空配列に落とされるため注意。実測で確認済み）。
const PLATFORM_LABELS = { x: "x", threads: "threads", facebook: "facebook", instagram: "instagram" };

function monthRange(year, month) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function listPendingScheduledPosts(customerCode, year, month) {
  const { start, end } = monthRange(year, month);
  const filters = [
    `customer_code[equals]${encodeURIComponent(customerCode)}`,
    `status[equals]pending`,
    `scheduled_at[greater_than]${encodeURIComponent(start)}`,
    `scheduled_at[less_than]${encodeURIComponent(end)}`,
  ].join("[and]");

  const all = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    const res = await microcmsFetch(`/scheduled_posts?filters=${filters}&limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[scheduledPostStore] listPendingScheduledPosts failed ${res.status} ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const contents = Array.isArray(json.contents) ? json.contents : [];
    all.push(...contents);
    if (contents.length < limit) break;
    offset += limit;
  }
  return all;
}

/** 指定顧客の全期間・全ステータスの予約投稿を全件取得する（投稿一覧画面用。ページング） */
async function listAllScheduledPostsForCustomer(customerCode) {
  const all = [];
  const limit = 100;
  let offset = 0;
  const filters = `customer_code[equals]${encodeURIComponent(customerCode)}`;
  for (;;) {
    const res = await microcmsFetch(`/scheduled_posts?filters=${filters}&limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[scheduledPostStore] listAllScheduledPostsForCustomer failed ${res.status} ${text.slice(0, 300)}`);
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
 * 指定顧客・指定月のpending予約投稿を集計する。
 * @returns {{ counts: {x:number,threads:number,facebook:number,instagram:number}, xUrlCount: number, totalCount: number }}
 */
async function getScheduledPostsSummary(customerCode, year, month) {
  const posts = await listPendingScheduledPosts(customerCode, year, month);
  const counts = { x: 0, threads: 0, facebook: 0, instagram: 0 };
  let xUrlCount = 0;

  for (const post of posts) {
    const label = Array.isArray(post.platform) ? post.platform[0] : post.platform;
    const key = Object.keys(PLATFORM_LABELS).find((k) => PLATFORM_LABELS[k] === label);
    if (!key) continue;
    counts[key] += 1;
    if (key === "x" && post.contains_url) xUrlCount += 1;
  }

  const totalCount = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { counts, xUrlCount, totalCount };
}

/**
 * 予約投稿を1件作成する（status=pending）。実際の投稿・課金はここでは行わない。
 * @param {string} customerCode microCMS顧客レコードid（req.customer.id）
 * @param {string} createdBy 予約を作成したユーザーid（req.user.userId）
 * @param {string} platform "x" | "threads" | "facebook" | "instagram"
 * @param {string} [imageUrl] Instagram投稿に必須の画像URL（他プラットフォームでは未使用）
 * @param {string} [sourceScheduleId] スケジュール投稿（post_schedules）から生成された場合のみ設定
 */
async function createScheduledPost({
  customerCode,
  createdBy,
  platform,
  content,
  scheduledAt,
  containsUrl,
  imageUrl,
  sourceScheduleId,
}) {
  const res = await microcmsFetch(`/scheduled_posts`, {
    method: "POST",
    body: JSON.stringify({
      customer_code: customerCode,
      created_by: createdBy,
      platform: [PLATFORM_LABELS[platform]],
      content: content || "",
      scheduled_at: scheduledAt,
      status: ["pending"],
      contains_url: Boolean(containsUrl),
      image_url: imageUrl || "",
      source_schedule_id: sourceScheduleId || "",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[scheduledPostStore] createScheduledPost failed ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

// SCOPE_CUTOFF_AT より前のscheduled_atを持つ予約は対象外にする（この実行エンジン導入前に
// 作られた予約は「実際に実行される」という前提なしに作られたものが混在するため、
// 導入後に新規作成された予約のみを自動実行の対象とする）。
// created_by="test" は手動テストで作った投稿のため、誤って実SNSへ投稿しないよう常に除外する。
async function listDuePendingScheduledPosts(cutoffIso) {
  const nowIso = new Date().toISOString();
  const filters = [
    "status[equals]pending",
    `scheduled_at[less_than]${encodeURIComponent(nowIso)}`,
    `scheduled_at[greater_than]${encodeURIComponent(cutoffIso)}`,
    "created_by[not_equals]test",
  ].join("[and]");

  const all = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    const res = await microcmsFetch(`/scheduled_posts?filters=${filters}&limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[scheduledPostStore] listDuePendingScheduledPosts failed ${res.status} ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const contents = Array.isArray(json.contents) ? json.contents : [];
    all.push(...contents);
    if (contents.length < limit) break;
    offset += limit;
  }
  return all;
}

/** 実行結果を反映する。statusの有効な選択肢は"pending"/"done"/"failed"（microCMS側で定義済み）。 */
async function markScheduledPostStatus(id, status) {
  const res = await microcmsFetch(`/scheduled_posts/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: [status] }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[scheduledPostStore] markScheduledPostStatus failed ${res.status} ${text.slice(0, 300)}`);
  }
}

/** スケジュール投稿（post_schedules）から生成された、まだ実行されていない予約を列挙する。
 * 一時停止・削除時に未実行分をまとめて取り消すために使う。 */
async function listPendingBySourceSchedule(scheduleId) {
  const filters = [`source_schedule_id[equals]${encodeURIComponent(scheduleId)}`, "status[equals]pending"].join("[and]");
  const all = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    const res = await microcmsFetch(`/scheduled_posts?filters=${filters}&limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[scheduledPostStore] listPendingBySourceSchedule failed ${res.status} ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const contents = Array.isArray(json.contents) ? json.contents : [];
    all.push(...contents);
    if (contents.length < limit) break;
    offset += limit;
  }
  return all;
}

async function deleteScheduledPost(id) {
  const res = await microcmsFetch(`/scheduled_posts/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`[scheduledPostStore] deleteScheduledPost failed ${res.status} ${text.slice(0, 300)}`);
  }
}

module.exports = {
  PLATFORM_LABELS,
  listPendingScheduledPosts,
  listAllScheduledPostsForCustomer,
  listDuePendingScheduledPosts,
  listPendingBySourceSchedule,
  markScheduledPostStatus,
  deleteScheduledPost,
  getScheduledPostsSummary,
  createScheduledPost,
};
