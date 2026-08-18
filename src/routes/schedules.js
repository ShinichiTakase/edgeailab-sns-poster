// スケジュール投稿（曜日・時間帯を指定して継続的に自動投稿するスケジュール）のCRUD API。
// 実際の投稿生成・実行は scheduleMaterializer.js / scheduledPostRunner.js（cron）が担い、
// このルートはスケジュール本体・投稿文章の設定管理のみを扱う。
const express = require("express");
const { requireAuth, requireVerified, blockExpiredTrial } = require("../middleware/requireAuth");
const scheduleStore = require("../lib/scheduleStore");
const scheduleTextStore = require("../lib/scheduleTextStore");
const { listPendingBySourceSchedule, deleteScheduledPost } = require("../lib/scheduledPostStore");
const { isSlotWideEnough } = require("../lib/scheduleFiring");

const router = express.Router();

const PLATFORMS = ["x", "threads", "facebook", "instagram"];
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function buildSlots(body) {
  return [
    { start: body.slot1Start, end: body.slot1End },
    { start: body.slot2Start, end: body.slot2End },
    { start: body.slot3Start, end: body.slot3End },
  ].filter((s) => s.start && s.end);
}

// スケジュール登録・編集で共通のバリデーション。
function validateScheduleInput(body) {
  if (typeof body.name !== "string" || !body.name.trim()) return "name_required";
  if (!Array.isArray(body.platforms) || body.platforms.length === 0 || body.platforms.some((p) => !PLATFORMS.includes(p))) {
    return "invalid_platforms";
  }
  if (!Array.isArray(body.weekdays) || body.weekdays.length === 0 || body.weekdays.some((w) => !WEEKDAYS.includes(w))) {
    return "weekdays_required";
  }
  const dailyPostCount = Number(body.dailyPostCount);
  if (!Number.isInteger(dailyPostCount) || dailyPostCount < 1 || dailyPostCount > 3) {
    return "invalid_daily_post_count";
  }
  const slots = buildSlots(body);
  if (slots.length < dailyPostCount) {
    return "not_enough_slots";
  }
  if (slots.some((s) => !isSlotWideEnough(s))) {
    return "slot_too_narrow";
  }
  if (!body.startDate) return "start_date_required";
  if (body.endDate && new Date(body.endDate).getTime() < new Date(body.startDate).getTime()) {
    return "invalid_end_date";
  }
  return null;
}

function toDateSummary(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 一覧・詳細表示用の整形（フロントに渡す形に正規化する）。
function serializeSchedule(schedule, textCount) {
  const platforms = Array.isArray(schedule.platforms) ? schedule.platforms : [];
  const weekdays = Array.isArray(schedule.weekdays) ? schedule.weekdays : [];
  return {
    id: schedule.id,
    name: schedule.name,
    platforms,
    urlMode: Boolean(schedule.url_mode),
    startDate: toDateSummary(schedule.start_date),
    endDate: toDateSummary(schedule.end_date),
    weekdays,
    dailyPostCount: Number(schedule.daily_post_count) || 0,
    slots: [
      { start: schedule.slot1_start || "", end: schedule.slot1_end || "" },
      { start: schedule.slot2_start || "", end: schedule.slot2_end || "" },
      { start: schedule.slot3_start || "", end: schedule.slot3_end || "" },
    ].filter((s) => s.start && s.end),
    isPaused: Boolean(schedule.is_paused),
    autoPaused: Boolean(schedule.auto_paused),
    facebookPageId: schedule.facebook_page_id || null,
    createdBy: schedule.created_by,
    createdAt: schedule.createdAt,
    textCount: textCount ?? null,
  };
}

// 未実行分（source_schedule_id一致・pending）を取り消す。一時停止・削除の両方から使う。
async function cancelPendingGeneratedPosts(scheduleId) {
  const pending = await listPendingBySourceSchedule(scheduleId);
  await Promise.all(pending.map((p) => deleteScheduledPost(p.id)));
  return pending.length;
}

router.get("/api/schedules", requireAuth, async (req, res) => {
  try {
    const schedules = await scheduleStore.listSchedulesForCustomer(req.customer.id);
    schedules.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const emailByUserId = new Map();
    for (const user of req.customer.users || []) {
      emailByUserId.set(user.userId, user.email);
    }

    const rows = await Promise.all(
      schedules.map(async (s) => {
        const texts = await scheduleTextStore.listScheduleTexts(s.id);
        return {
          ...serializeSchedule(s, texts.length),
          createdByEmail: emailByUserId.get(s.created_by) || null,
        };
      })
    );
    res.json({ schedules: rows });
  } catch (err) {
    console.error(`[schedules] list failed customerId=${req.customer.id}:`, err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.post("/api/schedules", requireAuth, requireVerified, blockExpiredTrial, express.json(), async (req, res) => {
  const validationError = validateScheduleInput(req.body || {});
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }
  const body = req.body;
  try {
    const created = await scheduleStore.createSchedule({
      customerCode: req.customer.id,
      createdBy: req.user.userId,
      name: body.name.trim(),
      platforms: body.platforms,
      urlMode: body.urlMode,
      startDate: body.startDate,
      endDate: body.endDate || null,
      weekdays: body.weekdays,
      dailyPostCount: Number(body.dailyPostCount),
      slots: buildSlots(body),
      facebookPageId: body.facebookPageId || null,
    });
    res.json({ id: created.id });
  } catch (err) {
    console.error(`[schedules] create failed customerId=${req.customer.id}:`, err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.get("/api/schedules/:id", requireAuth, async (req, res) => {
  try {
    const schedule = await scheduleStore.getScheduleById(req.params.id);
    if (!schedule || schedule.customer_code !== req.customer.id) {
      return res.status(404).json({ error: "not_found" });
    }
    const texts = await scheduleTextStore.listScheduleTexts(schedule.id);
    res.json(serializeSchedule(schedule, texts.length));
  } catch (err) {
    console.error(`[schedules] get failed id=${req.params.id}:`, err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.patch("/api/schedules/:id", requireAuth, requireVerified, blockExpiredTrial, express.json(), async (req, res) => {
  const validationError = validateScheduleInput(req.body || {});
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }
  const body = req.body;
  try {
    const schedule = await scheduleStore.getScheduleById(req.params.id);
    if (!schedule || schedule.customer_code !== req.customer.id) {
      return res.status(404).json({ error: "not_found" });
    }
    const slots = buildSlots(body);
    await scheduleStore.updateSchedule(schedule.id, {
      name: body.name.trim(),
      platforms: body.platforms,
      url_mode: Boolean(body.urlMode),
      start_date: body.startDate,
      end_date: body.endDate || "",
      weekdays: body.weekdays,
      daily_post_count: Number(body.dailyPostCount),
      slot1_start: slots[0]?.start || "",
      slot1_end: slots[0]?.end || "",
      slot2_start: slots[1]?.start || "",
      slot2_end: slots[1]?.end || "",
      slot3_start: slots[2]?.start || "",
      slot3_end: slots[2]?.end || "",
      facebook_page_id: body.facebookPageId || "",
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(`[schedules] update failed id=${req.params.id}:`, err);
    res.status(500).json({ error: "internal_error" });
  }
});

// 一時停止トグル（ユーザー操作。is_pausedのみ操作し、システム側のauto_pausedには触れない）。
router.patch("/api/schedules/:id/pause", requireAuth, express.json(), async (req, res) => {
  const isPaused = Boolean((req.body || {}).isPaused);
  try {
    const schedule = await scheduleStore.getScheduleById(req.params.id);
    if (!schedule || schedule.customer_code !== req.customer.id) {
      return res.status(404).json({ error: "not_found" });
    }
    await scheduleStore.updateSchedule(schedule.id, { is_paused: isPaused });
    let canceledCount = 0;
    if (isPaused) {
      canceledCount = await cancelPendingGeneratedPosts(schedule.id);
    }
    res.json({ ok: true, canceledCount });
  } catch (err) {
    console.error(`[schedules] pause toggle failed id=${req.params.id}:`, err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.delete("/api/schedules/:id", requireAuth, async (req, res) => {
  try {
    const schedule = await scheduleStore.getScheduleById(req.params.id);
    if (!schedule || schedule.customer_code !== req.customer.id) {
      return res.status(404).json({ error: "not_found" });
    }
    await cancelPendingGeneratedPosts(schedule.id);
    const texts = await scheduleTextStore.listScheduleTexts(schedule.id);
    await Promise.all(texts.map((t) => scheduleTextStore.deleteScheduleText(t.id)));
    await scheduleStore.deleteSchedule(schedule.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[schedules] delete failed id=${req.params.id}:`, err);
    res.status(500).json({ error: "internal_error" });
  }
});

// ---------- 投稿文章（画面3のCRUD） ----------

async function loadOwnedSchedule(req, res) {
  const schedule = await scheduleStore.getScheduleById(req.params.id);
  if (!schedule || schedule.customer_code !== req.customer.id) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  return schedule;
}

router.get("/api/schedules/:id/texts", requireAuth, async (req, res) => {
  try {
    const schedule = await loadOwnedSchedule(req, res);
    if (!schedule) return;
    const texts = await scheduleTextStore.listScheduleTexts(schedule.id);
    res.json({
      texts: texts.map((t) => ({
        id: t.id,
        xText: t.x_text || "",
        threadsText: t.threads_text || "",
        facebookText: t.facebook_text || "",
        instagramText: t.instagram_text || "",
        instagramImageUrl: t.instagram_image_url || "",
        createdAt: t.createdAt,
      })),
    });
  } catch (err) {
    console.error(`[schedules] list texts failed id=${req.params.id}:`, err);
    res.status(500).json({ error: "internal_error" });
  }
});

function validateTextInput(schedule, body) {
  const platforms = Array.isArray(schedule.platforms) ? schedule.platforms : [];
  for (const platform of platforms) {
    const key = { x: "xText", threads: "threadsText", facebook: "facebookText", instagram: "instagramText" }[platform];
    if (!body[key] || !body[key].trim()) return "text_required";
  }
  if (platforms.includes("instagram") && !body.instagramImageUrl) {
    return "instagram_image_required";
  }
  return null;
}

router.post("/api/schedules/:id/texts", requireAuth, requireVerified, blockExpiredTrial, express.json(), async (req, res) => {
  try {
    const schedule = await loadOwnedSchedule(req, res);
    if (!schedule) return;
    const validationError = validateTextInput(schedule, req.body || {});
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    const body = req.body;
    const created = await scheduleTextStore.createScheduleText({
      scheduleId: schedule.id,
      xText: body.xText,
      threadsText: body.threadsText,
      facebookText: body.facebookText,
      instagramText: body.instagramText,
      instagramImageUrl: body.instagramImageUrl,
    });
    res.json({ id: created.id });
  } catch (err) {
    console.error(`[schedules] create text failed id=${req.params.id}:`, err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.patch(
  "/api/schedules/:id/texts/:textId",
  requireAuth,
  requireVerified,
  blockExpiredTrial,
  express.json(),
  async (req, res) => {
    try {
      const schedule = await loadOwnedSchedule(req, res);
      if (!schedule) return;
      const existing = await scheduleTextStore.getScheduleTextById(req.params.textId);
      if (!existing || existing.schedule_id !== schedule.id) {
        return res.status(404).json({ error: "not_found" });
      }
      const validationError = validateTextInput(schedule, req.body || {});
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }
      const body = req.body;
      await scheduleTextStore.updateScheduleText(existing.id, {
        x_text: body.xText || "",
        threads_text: body.threadsText || "",
        facebook_text: body.facebookText || "",
        instagram_text: body.instagramText || "",
        instagram_image_url: body.instagramImageUrl || "",
      });
      res.json({ ok: true });
    } catch (err) {
      console.error(`[schedules] update text failed id=${req.params.textId}:`, err);
      res.status(500).json({ error: "internal_error" });
    }
  }
);

router.delete("/api/schedules/:id/texts/:textId", requireAuth, async (req, res) => {
  try {
    const schedule = await loadOwnedSchedule(req, res);
    if (!schedule) return;
    const existing = await scheduleTextStore.getScheduleTextById(req.params.textId);
    if (!existing || existing.schedule_id !== schedule.id) {
      return res.status(404).json({ error: "not_found" });
    }
    await scheduleTextStore.deleteScheduleText(existing.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[schedules] delete text failed id=${req.params.textId}:`, err);
    res.status(500).json({ error: "internal_error" });
  }
});

module.exports = router;
