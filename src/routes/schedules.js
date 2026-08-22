// スケジュール投稿（曜日・時間帯を指定して継続的に自動投稿するスケジュール）のCRUD API。
// 実際の投稿生成・実行は scheduleMaterializer.js / scheduledPostRunner.js（cron）が担い、
// このルートはスケジュール本体・投稿文章の設定管理のみを扱う。
const express = require("express");
const { requireAuth, requireVerified, blockExpiredTrial, blockViewerRole } = require("../middleware/requireAuth");
const scheduleStore = require("../lib/scheduleStore");
const scheduleTextStore = require("../lib/scheduleTextStore");
const { listPendingBySourceSchedule, deleteScheduledPost } = require("../lib/scheduledPostStore");
const { isSlotWideEnough, dateOnly } = require("../lib/scheduleFiring");
const { getDocsNumber } = require("../lib/generationConfig");
const { roleOf } = require("../lib/customerStore");
const approvalStore = require("../lib/approvalStore");

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

// 本日分がscheduleMaterializer.jsによって既に生成済みか（last_materialized_dtが
// 今日の日付と一致するか）。生成済みなら、投稿文章を編集しても本日分の
// scheduled_postsには反映されないため、画面3で注記を出す判定に使う。
function isMaterializedToday(schedule) {
  if (!schedule.last_materialized_dt) return false;
  return dateOnly(new Date(schedule.last_materialized_dt)).getTime() === dateOnly(new Date()).getTime();
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
    materializedToday: isMaterializedToday(schedule),
    facebookPageId: schedule.facebook_page_id || null,
    createdBy: schedule.created_by,
    createdAt: schedule.createdAt,
    textCount: textCount ?? null,
  };
}

// 未実行分（source_schedule_id一致・pending）を取り消す。一時停止・削除の両方から使う。
// microCMSへの書き込みは並行数が多いと429（Too many requests）で弾かれるため
// （texts/bulk作成時に実際に発生していた）、1件ずつ順番に削除する。
async function cancelPendingGeneratedPosts(scheduleId) {
  const pending = await listPendingBySourceSchedule(scheduleId);
  for (const p of pending) {
    await deleteScheduledPost(p.id);
  }
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

router.post("/api/schedules", requireAuth, requireVerified, blockExpiredTrial, blockViewerRole, express.json(), async (req, res) => {
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

router.patch("/api/schedules/:id", requireAuth, requireVerified, blockExpiredTrial, blockViewerRole, express.json(), async (req, res) => {
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
router.patch("/api/schedules/:id/pause", requireAuth, blockViewerRole, express.json(), async (req, res) => {
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

router.delete("/api/schedules/:id", requireAuth, blockViewerRole, async (req, res) => {
  try {
    const schedule = await scheduleStore.getScheduleById(req.params.id);
    if (!schedule || schedule.customer_code !== req.customer.id) {
      return res.status(404).json({ error: "not_found" });
    }
    await cancelPendingGeneratedPosts(schedule.id);
    const texts = await scheduleTextStore.listScheduleTexts(schedule.id);
    // microCMSへの書き込みは並行数が多いと429で弾かれるため、1件ずつ順番に削除する。
    for (const t of texts) {
      await scheduleTextStore.deleteScheduleText(t.id);
    }
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
        instagramVideoUrl: t.instagram_video_url || "",
        sourceExcerpt: t.source_excerpt || "",
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
  // Instagramは画像投稿（旧仕様の単発編集）・動画投稿（新仕様のリール）のいずれかが必須。
  if (platforms.includes("instagram") && !body.instagramImageUrl && !body.instagramVideoUrl) {
    return "instagram_media_required";
  }
  return null;
}

// スケジュール投稿の「投稿文章を追加」画面から、1回の操作でgetDocsNumber()件のエントリを
// まとめて作成する（ラウンドロビン用のバリエーションを一括登録するため）。フロントエンドの
// 描画数（schedule-detail.htmlのBULK_COUNT、GET /api/ai/configから取得）と一致させる必要がある。
router.post(
  "/api/schedules/:id/texts/bulk",
  requireAuth,
  requireVerified,
  blockExpiredTrial,
  blockViewerRole,
  express.json(),
  async (req, res) => {
    try {
      const schedule = await loadOwnedSchedule(req, res);
      if (!schedule) return;
      const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
      if (entries.length !== getDocsNumber()) {
        return res.status(400).json({ error: "invalid_entry_count" });
      }
      // 投稿文章一覧での識別しやすさのため、生成元（URLまたは原文の抜粋）を各エントリに
      // 記録する。1回の一括登録は同じ生成元から作られるため、バッチ単位で1つ受け取る。
      const sourceExcerpt = typeof req.body?.sourceExcerpt === "string" ? req.body.sourceExcerpt.slice(0, 200) : "";
      for (const entry of entries) {
        const validationError = validateTextInput(schedule, entry || {});
        if (validationError) {
          return res.status(400).json({ error: validationError });
        }
      }

      // 編集者は必ず承認依頼を経由する（[保存]の代わりに[承認依頼]。承認者は招待時に
      // 紐付けたapproverIds、role="編集者"以外は不要）。承認完了までscheduleMaterializer.js
      // の自動生成プールから除外される（scheduleTextStore.listApprovedScheduleTexts参照）。
      const isEditor = roleOf(req.user) === "編集者";
      let approverIds = [];
      if (isEditor) {
        approverIds = JSON.parse(req.user.approverIds || "[]");
        if (approverIds.length === 0) {
          return res.status(400).json({ error: "no_approver_configured" });
        }
      }
      const approvalFields = isEditor ? approvalStore.buildApprovalFields(approverIds) : approvalStore.noneApprovalFields();

      // microCMSへの書き込みは並行数が多いと429（Too many requests）で弾かれるため
      // （10件同時のPromise.allで実際に発生していた）、1件ずつ順番に作成する。
      // 途中で失敗した場合は、それまでに作成済みの分をロールバック（削除）してから
      // エラーを返す。中途半端な件数だけ保存された状態で終わらせないため。
      const created = [];
      try {
        for (const entry of entries) {
          const record = await scheduleTextStore.createScheduleText({
            scheduleId: schedule.id,
            xText: entry.xText,
            threadsText: entry.threadsText,
            facebookText: entry.facebookText,
            instagramText: entry.instagramText,
            instagramImageUrl: entry.instagramImageUrl,
            instagramVideoUrl: entry.instagramVideoUrl,
            sourceExcerpt,
            createdBy: req.user.userId,
            approvalFields,
          });
          created.push(record);
        }
      } catch (err) {
        for (const c of created) {
          await scheduleTextStore.deleteScheduleText(c.id).catch(() => {});
        }
        throw err;
      }

      if (isEditor) {
        const approvals = JSON.parse(approvalFields.approvals_json);
        const summary = `スケジュール「${schedule.name}」の投稿文章バッチ（${created.length}件、生成元: ${sourceExcerpt || "不明"}）`;
        await approvalStore.sendApprovalRequestEmails({
          customer: req.customer,
          requesterUser: req.user,
          approvals,
          summary,
        });
      }

      res.json({ ids: created.map((c) => c.id), approvalRequested: isEditor });
    } catch (err) {
      console.error(`[schedules] bulk create text failed id=${req.params.id}:`, err);
      res.status(500).json({ error: "internal_error" });
    }
  }
);

router.post("/api/schedules/:id/texts", requireAuth, requireVerified, blockExpiredTrial, blockViewerRole, express.json(), async (req, res) => {
  try {
    const schedule = await loadOwnedSchedule(req, res);
    if (!schedule) return;
    const validationError = validateTextInput(schedule, req.body || {});
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    const body = req.body;
    // このエンドポイントは承認ゲート対象外（単発の追加・再生成用）。承認状態フィールドを
    // 明示的にnoneにしておかないと自動生成プールの絞り込み（approval_status[contains]...）
    // に引っかからず、永久にプール対象外になってしまうため必ず書き込む。
    const created = await scheduleTextStore.createScheduleText({
      scheduleId: schedule.id,
      xText: body.xText,
      threadsText: body.threadsText,
      facebookText: body.facebookText,
      instagramText: body.instagramText,
      instagramImageUrl: body.instagramImageUrl,
      sourceExcerpt: typeof body.sourceExcerpt === "string" ? body.sourceExcerpt.slice(0, 200) : "",
      createdBy: req.user.userId,
      approvalFields: approvalStore.noneApprovalFields(),
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
  blockViewerRole,
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
        instagram_video_url: body.instagramVideoUrl || "",
      });
      res.json({ ok: true });
    } catch (err) {
      console.error(`[schedules] update text failed id=${req.params.textId}:`, err);
      res.status(500).json({ error: "internal_error" });
    }
  }
);

router.delete("/api/schedules/:id/texts/:textId", requireAuth, blockViewerRole, async (req, res) => {
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
