// スケジュール投稿の「投稿文章を追加」画面、Instagramタブ用のAI動画生成API。
// 生成は数分かかるため、POST /generate はジョブIDのみ即時返し、実際の進捗は
// GET /jobs/:jobId をクライアント側でポーリングする方式にしている。
const express = require("express");
const { requireAuth, requireVerified, blockExpiredTrial, blockViewerRole } = require("../middleware/requireAuth");
const scheduleStore = require("../lib/scheduleStore");
const {
  startVideoGenerationJob,
  getJob,
  serializeJob,
  cancelJob,
  regenerateSingleVideo,
} = require("../lib/videoGenerationJobStore");

const router = express.Router();

async function loadOwnedSchedule(req, res) {
  const schedule = await scheduleStore.getScheduleById(req.params.id);
  if (!schedule || schedule.customer_code !== req.customer.id) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  return schedule;
}

router.post(
  "/api/schedules/:id/texts/videos/generate",
  requireAuth,
  requireVerified,
  blockExpiredTrial,
  blockViewerRole,
  express.json(),
  async (req, res) => {
    try {
      const schedule = await loadOwnedSchedule(req, res);
      if (!schedule) return;

      const useUrl = Boolean(schedule.url_mode);
      const { sourceText, url } = req.body || {};
      if (useUrl) {
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
          return res.status(400).json({ error: "invalid_url" });
        }
      } else if (typeof sourceText !== "string" || !sourceText.trim()) {
        return res.status(400).json({ error: "source_text_required" });
      }

      const job = startVideoGenerationJob({ sourceText, url: useUrl ? url : undefined });
      res.json({ jobId: job.id });
    } catch (err) {
      console.error(`[scheduleVideos] generate failed id=${req.params.id}:`, err);
      res.status(500).json({ error: "internal_error" });
    }
  }
);

router.get("/api/schedules/:id/texts/videos/jobs/:jobId", requireAuth, async (req, res) => {
  const schedule = await loadOwnedSchedule(req, res);
  if (!schedule) return;
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "not_found" });
  res.json(serializeJob(job));
});

router.post("/api/schedules/:id/texts/videos/jobs/:jobId/cancel", requireAuth, blockViewerRole, async (req, res) => {
  const schedule = await loadOwnedSchedule(req, res);
  if (!schedule) return;
  const ok = cancelJob(req.params.jobId);
  if (!ok) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

router.post(
  "/api/schedules/:id/texts/videos/regenerate",
  requireAuth,
  requireVerified,
  blockExpiredTrial,
  blockViewerRole,
  express.json(),
  async (req, res) => {
    try {
      const schedule = await loadOwnedSchedule(req, res);
      if (!schedule) return;
      const { caption } = req.body || {};
      if (typeof caption !== "string" || !caption.trim()) {
        return res.status(400).json({ error: "caption_required" });
      }
      const result = await regenerateSingleVideo({ caption });
      res.json(result);
    } catch (err) {
      console.error(`[scheduleVideos] regenerate failed id=${req.params.id}:`, err);
      res.status(500).json({ error: "video_generation_failed" });
    }
  }
);

module.exports = router;
