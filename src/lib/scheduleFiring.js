// スケジュール投稿（post_schedules）の曜日・時間帯枠パターンに関する共通ロジック。
// scheduleMaterializer.js（実際に生成）とscheduleForecast.js（請求予測シミュレーション）の
// 両方から使う単一情報源。
//
// 日時の扱い: このコンテナのタイムゾーンはAsia/Tokyo固定（Dockerfile/実行環境で設定済み、
// `date`コマンドで確認済み）。そのためJSのDateのローカルメソッド（getDate/getHours等）は
// そのままJST基準の値になり、UTCとの手動変換は不要。start_date/end_dateは日付のみの
// 概念なので、時刻部分は無視してY/M/Dのみで比較する。

const WEEKDAY_BY_JS_DAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MIN_SLOT_MINUTES = 30;

function dateOnly(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function weekdayKeyForDate(date) {
  return WEEKDAY_BY_JS_DAY[date.getDay()];
}

function normalizeWeekdays(schedule) {
  return Array.isArray(schedule.weekdays) ? schedule.weekdays : [];
}

function matchesWeekday(schedule, date) {
  return normalizeWeekdays(schedule).includes(weekdayKeyForDate(date));
}

function isDateInScheduleRange(schedule, date) {
  const day = dateOnly(date).getTime();
  if (schedule.start_date) {
    if (day < dateOnly(new Date(schedule.start_date)).getTime()) return false;
  }
  if (schedule.end_date) {
    if (day > dateOnly(new Date(schedule.end_date)).getTime()) return false;
  }
  return true;
}

/** "HH:MM"文字列を当日基準の分数（0-1439）に変換する */
function timeStringToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** スケジュールに設定されている時間帯枠を、空欄を除いて配列で返す（登録順=枠1,2,3順）。 */
function getConfiguredSlots(schedule) {
  const raw = [
    { start: schedule.slot1_start, end: schedule.slot1_end },
    { start: schedule.slot2_start, end: schedule.slot2_end },
    { start: schedule.slot3_start, end: schedule.slot3_end },
  ];
  return raw.filter((s) => s.start && s.end);
}

/** 枠の幅が最低30分あるか（登録時バリデーション用）。不正な時刻形式もfalseを返す。 */
function isSlotWideEnough(slot) {
  const start = timeStringToMinutes(slot.start);
  const end = timeStringToMinutes(slot.end);
  if (start === null || end === null) return false;
  return end - start >= MIN_SLOT_MINUTES;
}

/** その日に実際に配信する回数。「設定した投稿回数」「実際に設定されている枠数」
 * 「登録済み投稿文章数」のうち最小値に自動的にクランプする
 * （同日内で同じ文章が2回使われないようにするため）。 */
function effectiveDailyCount(schedule, textCount) {
  const configuredSlots = getConfiguredSlots(schedule);
  return Math.max(0, Math.min(Number(schedule.daily_post_count) || 0, configuredSlots.length, textCount));
}

/** 指定日（そのローカル日付の00:00起点）・指定枠の中から一様乱数でDateを1つ選ぶ。 */
function pickRandomTimeInSlot(dateOnlyValue, slot) {
  const startMin = timeStringToMinutes(slot.start);
  const endMin = timeStringToMinutes(slot.end);
  const offsetMin = startMin + Math.floor(Math.random() * (endMin - startMin));
  return new Date(dateOnlyValue.getTime() + offsetMin * 60 * 1000);
}

module.exports = {
  MIN_SLOT_MINUTES,
  weekdayKeyForDate,
  matchesWeekday,
  isDateInScheduleRange,
  getConfiguredSlots,
  isSlotWideEnough,
  effectiveDailyCount,
  pickRandomTimeInSlot,
  dateOnly,
};
