// スケジュール投稿（post_schedules）の将来投稿予定を、実行前にシミュレーションで
// 見積もる純粋関数。billing.js の請求予測（estimateBillingForecast）専用。
// 実データ（round_robin_index等）は一切書き換えない。
const { matchesWeekday, isDateInScheduleRange, getConfiguredSlots, effectiveDailyCount, dateOnly } = require("./scheduleFiring");
const { containsUrl } = require("./urlDetection");

const PLATFORM_TEXT_KEY = { x: "x_text", threads: "threads_text", facebook: "facebook_text", instagram: "instagram_text", linkedin: "linkedin_text" };

/**
 * windowStart（含む）からwindowEnd（含まない）までの間にこのスケジュールが生成するはずの
 * 投稿数を見積もる。「投稿数」はプラットフォームごとに1件と数える（1firingがN platformsなら
 * N件）。Xサーチャージ対象数（xUrlCount）は、firingで使われるテキストのx_textにURLが
 * 含まれ、かつXが選択プラットフォームに含まれる場合のみカウントする。
 *
 * 既にscheduleMaterializer.jsが生成済み（=last_materialized_dt以前）の日は、実データとして
 * scheduled_posts側（getScheduledPostsSummary）で既に集計されているため、二重カウントを
 * 避けるためシミュレーション対象から除外する。
 *
 * @param {object} schedule post_schedulesの1レコード
 * @param {object[]} texts schedule_textsの一覧（createdAt昇順）
 * @param {Date} windowStart
 * @param {Date} windowEnd
 */
function estimateScheduleFirings(schedule, texts, windowStart, windowEnd) {
  if (schedule.is_paused || schedule.auto_paused) {
    return { totalCount: 0, xUrlCount: 0 };
  }
  if (!Array.isArray(texts) || texts.length === 0) {
    return { totalCount: 0, xUrlCount: 0 };
  }

  const materializedThrough = schedule.last_materialized_dt
    ? new Date(dateOnly(new Date(schedule.last_materialized_dt)).getTime() + 24 * 60 * 60 * 1000)
    : null;

  let cursorDate = dateOnly(windowStart);
  if (materializedThrough && materializedThrough > cursorDate) {
    cursorDate = dateOnly(materializedThrough);
  }
  const end = dateOnly(windowEnd);

  const platforms = Array.isArray(schedule.platforms) ? schedule.platforms : [];
  let roundRobinIndex = Number(schedule.round_robin_index) || 0;
  let totalCount = 0;
  let xUrlCount = 0;

  // 無限ループ防止の安全弁（1年分=366日で十分。end_date未設定の請求予測は最大1ヶ月幅想定）。
  for (let i = 0; i < 366 && cursorDate.getTime() < end.getTime(); i++, cursorDate = new Date(cursorDate.getTime() + 24 * 60 * 60 * 1000)) {
    if (!matchesWeekday(schedule, cursorDate) || !isDateInScheduleRange(schedule, cursorDate)) continue;

    const n = effectiveDailyCount(schedule, texts.length);
    if (n === 0) continue;
    const slots = getConfiguredSlots(schedule).slice(0, n);
    if (slots.length === 0) continue;

    const inWindow = cursorDate.getTime() >= dateOnly(windowStart).getTime();

    for (let s = 0; s < n; s++) {
      const text = texts[roundRobinIndex % texts.length];
      roundRobinIndex += 1;

      if (!inWindow) continue; // materialize済み境界の調整用に消化だけ進める日（通常は発生しない）

      for (const platform of platforms) {
        const content = text[PLATFORM_TEXT_KEY[platform]] || "";
        if (!content.trim()) continue;
        totalCount += 1;
        if (platform === "x" && containsUrl(content)) xUrlCount += 1;
      }
    }
  }

  return { totalCount, xUrlCount };
}

module.exports = { estimateScheduleFirings };
