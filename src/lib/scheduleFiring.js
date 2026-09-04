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

/** ラウンドロビン消化順を「生成元（URL/原文）ごとに横断→次の生成順」に並び替える
 * （2026-09-02追加）。1回の一括生成（POST /texts/bulk）は1つの生成元URL/原文につき
 * 複数文書（DOCS_NUMBER件）をまとめて保存し、全件に同一のsource_excerptを共通して
 * 記録する（createScheduleText参照）。従来はscheduleTextStore.listApprovedScheduleTexts
 * が返す配列（createdAt昇順）をそのままラウンドロビンに使っていたため、一括生成の
 * 保存順（生成元URL単位でまとまって作成される）がそのまま消化順になり、「同じ生成元の
 * 文書を複数日連続で使い切ってから次の生成元に移る」形になっていた。これはラウンド
 * ロビンとして生成元の分散が働いておらず不自然という指摘を受け、生成元ごとに
 * グルーピングした上で「各生成元の1番目の文書→各生成元の2番目の文書→…」の順に
 * 転置する。生成元の識別はsource_excerpt文字列の完全一致（同一の一括生成呼び出しは
 * 全エントリに同じ文字列を記録するため）。source_excerptが無い旧データ・単発作成分は
 * 自分1件だけのグループとして扱う（他とまとまらず独立して順番が回ってくる）。
 * 生成元ごとの文書数が異なる場合、文書が尽きた生成元はその周回だけスキップする。 */
function orderTextsForRoundRobin(texts) {
  const groups = [];
  const groupIndexByKey = new Map();
  for (const text of texts) {
    const key = text.source_excerpt || `__no_source__:${text.id}`;
    if (!groupIndexByKey.has(key)) {
      groupIndexByKey.set(key, groups.length);
      groups.push([]);
    }
    groups[groupIndexByKey.get(key)].push(text);
  }
  const maxGroupLength = groups.reduce((max, g) => Math.max(max, g.length), 0);
  const ordered = [];
  for (let position = 0; position < maxGroupLength; position++) {
    for (const group of groups) {
      if (group[position]) ordered.push(group[position]);
    }
  }
  return ordered;
}

/** 指定日・指定枠が、指定時刻の時点で既に終了しているか（枠のend時刻を過ぎているか）。
 * 当日新規作成されたスケジュールが、既に終わった枠の分までまとめて即時投稿されてしまう
 * 不具合（2026-09-02発覚）を防ぐため、materializerはこの判定でtrueの枠をスキップする。 */
function isSlotElapsed(dateOnlyValue, slot, now) {
  const endMin = timeStringToMinutes(slot.end);
  const slotEnd = new Date(dateOnlyValue.getTime() + endMin * 60 * 1000);
  return slotEnd <= now;
}

/** 指定日（そのローカル日付の00:00起点）・指定枠の中から一様乱数でDateを1つ選ぶ。
 * `now`を渡すと、枠の開始時刻が既に過ぎている（＝枠の途中でスケジュールが新規作成された）
 * 場合に、選択範囲の下限を`now`まで繰り上げる。これにより「枠は始まっているが終わっては
 * いない」ケースでも、必ず現在時刻より後（＝枠の残り時間内）の時刻が選ばれ、過去時刻に
 * なって即時投稿されてしまうことがない。呼び出し側は事前に`isSlotElapsed`で完全に終了した
 * 枠を除外しておくこと（そうでないと選択範囲が空になり得る）。 */
function pickRandomTimeInSlot(dateOnlyValue, slot, now) {
  const startMin = timeStringToMinutes(slot.start);
  const endMin = timeStringToMinutes(slot.end);
  let effectiveStartMin = startMin;
  if (now) {
    const nowMin = Math.floor((now.getTime() - dateOnlyValue.getTime()) / (60 * 1000));
    if (nowMin > effectiveStartMin) effectiveStartMin = Math.min(nowMin, endMin - 1);
  }
  const offsetMin = effectiveStartMin + Math.floor(Math.random() * (endMin - effectiveStartMin));
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
  orderTextsForRoundRobin,
  isSlotElapsed,
  pickRandomTimeInSlot,
  dateOnly,
};
