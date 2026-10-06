// microCMS の scheduled_posts スキーマ（予約投稿）へのアクセス。
// 予約の作成（ワンショット投稿ウィザードの「予約」）、予定件数・請求予測表示用の集計読み取り、
// および実際の投稿実行（scheduledPostRunner.js）・再試行（scheduledPostRetryRunner.js）が
// 参照する検索系を担う。postingLogStore.jsと同様、selectフィールドは配列で書き込み・読み取りする
// （Array.isArrayで防御的に読む）。
const { microcmsFetch } = require("./microcms");

// microCMSのselectフィールド側の有効値は小文字のキーそのもの（"X"等の大文字表示ラベルは
// 無効値としてエラーなく空配列に落とされるため注意。実測で確認済み）。
const PLATFORM_LABELS = { x: "x", threads: "threads", facebook: "facebook", instagram: "instagram", linkedin: "linkedin" };

// 予約投稿の実行エンジン（scheduledPostRunner.js）をデプロイした時刻（固定値）。過去にこの
// 時刻より前のscheduled_atを持つpending/failed予約は、今後もこのエンジン・再試行エンジンの
// 対象にはしない（変更しないこと。書き換えると積み残っていた過去予約が一斉に実行されてしまう）。
const SCOPE_CUTOFF_AT = "2026-08-17T22:44:38.000Z";

async function listPendingScheduledPosts(customerCode, windowStart, windowEnd) {
  // statusはmicroCMSのセレクトフィールド（配列で書き込まれる。markScheduledPostStatus参照）のため、
  // [equals]では一致せず常に0件になる（実機で確認済み）。配列値に対する一致には[contains]を使う。
  const filters = [
    `customer_code[equals]${encodeURIComponent(customerCode)}`,
    `status[contains]pending`,
    `scheduled_at[greater_than]${encodeURIComponent(windowStart.toISOString())}`,
    `scheduled_at[less_than]${encodeURIComponent(windowEnd.toISOString())}`,
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
 * 指定顧客・指定期間のpending予約投稿を集計する。
 * @param {Date} windowStart 含む
 * @param {Date} windowEnd 含まない
 * @returns {{ counts: {x:number,threads:number,facebook:number,instagram:number}, xUrlCount: number, totalCount: number }}
 */
async function getScheduledPostsSummary(customerCode, windowStart, windowEnd) {
  const posts = await listPendingScheduledPosts(customerCode, windowStart, windowEnd);
  const counts = { x: 0, threads: 0, facebook: 0, instagram: 0, linkedin: 0 };
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
 * @param {string} [imageUrl] Instagram画像投稿に必須の画像URL（他プラットフォームでは未使用）
 * @param {string} [videoUrl] Instagramリール投稿に必須の動画URL（imageUrlと排他。他プラットフォームでは未使用）
 * @param {string} [sourceScheduleId] スケジュール投稿（post_schedules）から生成された場合のみ設定
 * @param {string} [facebookPageId] Facebook投稿先ページ（複数ページ連携時のみ。未指定なら実行時に先頭ページへフォールバック）
 * @param {boolean} [notifyEmail] 投稿後結果をメールで知らせるか（未指定はtrue扱い）。
 *   2026-08-27現在、scheduled_postsスキーマにnotify_emailフィールドが未作成のため未使用
 *   （書き込むと microCMS が400 "unexpected key" を返し予約作成自体が失敗する。実機で確認済み）。
 *   フィールド追加後、本文のnotify_email行を復元すること。
 */
async function createScheduledPost({
  customerCode,
  createdBy,
  platform,
  content,
  scheduledAt,
  containsUrl,
  imageUrl,
  videoUrl,
  sourceScheduleId,
  facebookPageId,
  // eslint-disable-next-line no-unused-vars
  notifyEmail,
  approvalFields,
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
      video_url: videoUrl || "",
      source_schedule_id: sourceScheduleId || "",
      facebook_page_id: facebookPageId || "",
      // 承認ステータス関連フィールド（approvalStore.jsのbuildApprovalFields/noneApprovalFields）。
      ...(approvalFields || {}),
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
  // statusはセレクトフィールド（配列書き込み）のため[contains]で一致させる（上のlistPendingScheduledPosts参照）。
  // 承認待ち・却下・失効中（編集者作成分）は除外する。included側をnone/approvedのORで絞ると、
  // 承認機能導入前からある既存予約（approval_status未設定＝空配列）が[contains]に一致せず
  // 全滅するため、excluded側をnot_containsで列挙する方式にする（実機検証済み、2026-08-21）。
  const filters = [
    "status[contains]pending",
    `scheduled_at[less_than]${encodeURIComponent(nowIso)}`,
    `scheduled_at[greater_than]${encodeURIComponent(cutoffIso)}`,
    "created_by[not_equals]test",
    "approval_status[not_contains]pending",
    "approval_status[not_contains]rejected",
    "approval_status[not_contains]expired",
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

// listDuePendingScheduledPostsと同じくSCOPE_CUTOFF_AT・created_by除外を適用する。
// 再試行対象の絞り込み（上限回数・次回再試行時刻）はscheduledPostRetryStore.js側で行うため、
// ここではstatus=failedの候補を全件返す。
async function listFailedScheduledPosts(cutoffIso) {
  const filters = [
    "status[contains]failed",
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
      throw new Error(`[scheduledPostStore] listFailedScheduledPosts failed ${res.status} ${text.slice(0, 300)}`);
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
  // statusはセレクトフィールド（配列書き込み）のため[contains]で一致させる（listPendingScheduledPosts参照）。
  const filters = [`source_schedule_id[equals]${encodeURIComponent(scheduleId)}`, "status[contains]pending"].join("[and]");
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

/** 指定顧客の、スケジュール投稿由来・ワンショット予約由来を問わない全pending予約を列挙する。
 * 解約時にまとめて取り消すために使う（listPendingBySourceScheduleはpost_schedules経由の
 * 生成分しか拾えないため、ワンショット投稿ウィザードからの直接予約も含めるにはこちらを使う）。 */
async function listPendingByCustomer(customerCode) {
  // statusはセレクトフィールド（配列書き込み）のため[contains]で一致させる（listPendingScheduledPosts参照）。
  const filters = [`customer_code[equals]${encodeURIComponent(customerCode)}`, "status[contains]pending"].join("[and]");
  const all = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    const res = await microcmsFetch(`/scheduled_posts?filters=${filters}&limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[scheduledPostStore] listPendingByCustomer failed ${res.status} ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const contents = Array.isArray(json.contents) ? json.contents : [];
    all.push(...contents);
    if (contents.length < limit) break;
    offset += limit;
  }
  return all;
}

/** 指定顧客の、指定プラットフォーム宛てのpending予約のみを列挙する。
 * SNS連携解除時に、その1プラットフォーム分だけを狙い撃ちで取り消すために使う
 * （listPendingByCustomerは顧客の全プラットフォームを返してしまうため流用不可）。 */
async function listPendingByCustomerAndPlatform(customerCode, platform) {
  // status・platformともにmicroCMSのセレクトフィールド（配列書き込み）のため、
  // [equals]では一致せず常に0件になる。[contains]で一致させる（listPendingScheduledPosts参照）。
  const filters = [
    `customer_code[equals]${encodeURIComponent(customerCode)}`,
    `status[contains]pending`,
    `platform[contains]${encodeURIComponent(platform)}`,
  ].join("[and]");
  const all = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    const res = await microcmsFetch(`/scheduled_posts?filters=${filters}&limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[scheduledPostStore] listPendingByCustomerAndPlatform failed ${res.status} ${text.slice(0, 300)}`);
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
  SCOPE_CUTOFF_AT,
  listPendingScheduledPosts,
  listAllScheduledPostsForCustomer,
  listDuePendingScheduledPosts,
  listFailedScheduledPosts,
  listPendingBySourceSchedule,
  listPendingByCustomer,
  listPendingByCustomerAndPlatform,
  markScheduledPostStatus,
  deleteScheduledPost,
  getScheduledPostsSummary,
  createScheduledPost,
};

module.exports = require("../data/storeSelector").selectStore("scheduledPostStore", module.exports);
