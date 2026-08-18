// microCMS の post_schedules スキーマ（スケジュール投稿の設定）へのアクセス。
// postingLogStore.js / scheduledPostStore.js と同じ構造。selectフィールドは配列で
// 書き込み・読み取りする（Array.isArrayで防御的に読む）。
const { microcmsFetch } = require("./microcms");

const PLATFORM_LABELS = { x: "x", threads: "threads", facebook: "facebook", instagram: "instagram" };
const WEEKDAY_LABELS = { mon: "mon", tue: "tue", wed: "wed", thu: "thu", fri: "fri", sat: "sat", sun: "sun" };

async function listAll(endpoint, filters) {
  const all = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    const qs = filters ? `?filters=${filters}&limit=${limit}&offset=${offset}` : `?limit=${limit}&offset=${offset}`;
    const res = await microcmsFetch(`/${endpoint}${qs}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[scheduleStore] list ${endpoint} failed ${res.status} ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const contents = Array.isArray(json.contents) ? json.contents : [];
    all.push(...contents);
    if (contents.length < limit) break;
    offset += limit;
  }
  return all;
}

/** 指定顧客のスケジュール一覧（画面1用。作成日時降順はルート側で並び替える） */
async function listSchedulesForCustomer(customerCode) {
  return listAll("post_schedules", `customer_code[equals]${encodeURIComponent(customerCode)}`);
}

/** 一時停止（is_paused）・自動停止（auto_paused）いずれも偽の全スケジュール（cron横断処理用） */
async function listActiveSchedules() {
  return listAll("post_schedules", "is_paused[equals]false[and]auto_paused[equals]false");
}

/** トライアル終了/解約による自動停止・自動再開の同期対象を洗い出すための全件取得 */
async function listAllSchedules() {
  return listAll("post_schedules");
}

async function getScheduleById(id) {
  const res = await microcmsFetch(`/post_schedules/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[scheduleStore] getScheduleById failed ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function createSchedule({
  customerCode,
  createdBy,
  name,
  platforms,
  urlMode,
  startDate,
  endDate,
  weekdays,
  dailyPostCount,
  slots,
  facebookPageId,
}) {
  const res = await microcmsFetch(`/post_schedules`, {
    method: "POST",
    body: JSON.stringify({
      customer_code: customerCode,
      created_by: createdBy,
      name,
      platforms: platforms.map((p) => PLATFORM_LABELS[p]),
      url_mode: Boolean(urlMode),
      start_date: startDate,
      end_date: endDate || "",
      weekdays: weekdays.map((w) => WEEKDAY_LABELS[w]),
      daily_post_count: dailyPostCount,
      slot1_start: slots[0]?.start || "",
      slot1_end: slots[0]?.end || "",
      slot2_start: slots[1]?.start || "",
      slot2_end: slots[1]?.end || "",
      slot3_start: slots[2]?.start || "",
      slot3_end: slots[2]?.end || "",
      is_paused: false,
      auto_paused: false,
      round_robin_index: 0,
      facebook_page_id: facebookPageId || "",
      last_materialized_dt: "",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[scheduleStore] createSchedule failed ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function updateSchedule(id, patch) {
  const res = await microcmsFetch(`/post_schedules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[scheduleStore] updateSchedule failed ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function deleteSchedule(id) {
  const res = await microcmsFetch(`/post_schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`[scheduleStore] deleteSchedule failed ${res.status} ${text.slice(0, 300)}`);
  }
}

module.exports = {
  PLATFORM_LABELS,
  WEEKDAY_LABELS,
  listSchedulesForCustomer,
  listActiveSchedules,
  listAllSchedules,
  getScheduleById,
  createSchedule,
  updateSchedule,
  deleteSchedule,
};
