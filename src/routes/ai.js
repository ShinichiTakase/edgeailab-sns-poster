const express = require("express");
const { requireAuth, blockExpiredTrial } = require("../middleware/requireAuth");
const { generatePostCopy, generatePostCopyVariations } = require("../lib/postCopyGenerator");
const { fetchUrlText } = require("../lib/urlTextFetcher");

const router = express.Router();

const PLATFORMS = ["x", "threads", "facebook", "instagram"];
// スケジュール投稿の「投稿文章を追加」画面で1回にまとめて作成するエントリ数
// （schedules.jsの/texts/bulkエンドポイントと合わせる）。
const VARIATION_COUNT = 10;

function validatePlatforms(platforms) {
  return Array.isArray(platforms) && platforms.length > 0 && platforms.every((p) => PLATFORMS.includes(p));
}

function handleGenerationError(res, err, logPrefix, customerId) {
  if (err.message === "anthropic_not_configured") {
    console.error(`${logPrefix} ANTHROPIC_API_KEY not configured`);
    return res.status(500).json({ error: "ai_not_configured" });
  }
  if (err.message === "ai_refusal") {
    return res.status(422).json({ error: "ai_refusal" });
  }
  if (err.message === "ai_output_truncated") {
    return res.status(422).json({ error: "ai_output_truncated" });
  }
  console.error(`${logPrefix} customerId=${customerId} failed:`, err);
  return res.status(502).json({ error: "ai_generation_failed" });
}

// 原文（URL未使用）からAI文案生成。投稿自体ではないためトライアル投稿数上限は関係ない。
// メール認証未完了でも文案作成自体は試せるようにする（ブロックするのは実際の投稿・予約のみ）。
router.post("/api/ai/generate-post", requireAuth, blockExpiredTrial, express.json(), async (req, res) => {
  const { platforms, sourceText } = req.body || {};
  if (!validatePlatforms(platforms)) {
    return res.status(400).json({ error: "invalid_platforms" });
  }
  if (typeof sourceText !== "string" || !sourceText.trim()) {
    return res.status(400).json({ error: "source_text_required" });
  }

  try {
    const results = await generatePostCopy({ sourceText, platforms });
    res.json({ results });
  } catch (err) {
    handleGenerationError(res, err, "[ai/generate-post]", req.customer.id);
  }
});

// URL指定でのAI文案生成。サーバー側で実際にURLをfetchして本文を取得してからAIに渡す
// （URL文字列だけをプロンプトに含めて「読んだふり」の生成をさせることは禁止）。
router.post(
  "/api/ai/generate-post-from-url",
  requireAuth,
  blockExpiredTrial,
  express.json(),
  async (req, res) => {
    const { platforms, url } = req.body || {};
    if (!validatePlatforms(platforms)) {
      return res.status(400).json({ error: "invalid_platforms" });
    }
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: "invalid_url" });
    }

    let sourceText;
    try {
      sourceText = await fetchUrlText(url);
    } catch (err) {
      console.error(`[ai/generate-post-from-url] fetch failed customerId=${req.customer.id} url=${url}:`, err);
      return res.status(400).json({ error: "url_fetch_failed" });
    }

    try {
      const results = await generatePostCopy({ sourceText, platforms, url });
      res.json({ results });
    } catch (err) {
      handleGenerationError(res, err, "[ai/generate-post-from-url]", req.customer.id);
    }
  }
);

// スケジュール投稿の「投稿文章を追加」画面用：1回の呼び出しでプラットフォームごとに
// VARIATION_COUNT件の異なる文案をまとめて生成する（ラウンドロビン投稿での連続投稿が
// 似た文面にならないようにするため）。
router.post(
  "/api/ai/generate-post-variations",
  requireAuth,
  blockExpiredTrial,
  express.json(),
  async (req, res) => {
    const { platforms, sourceText } = req.body || {};
    if (!validatePlatforms(platforms)) {
      return res.status(400).json({ error: "invalid_platforms" });
    }
    if (typeof sourceText !== "string" || !sourceText.trim()) {
      return res.status(400).json({ error: "source_text_required" });
    }

    try {
      const results = await generatePostCopyVariations({ sourceText, platforms, count: VARIATION_COUNT });
      res.json({ results });
    } catch (err) {
      handleGenerationError(res, err, "[ai/generate-post-variations]", req.customer.id);
    }
  }
);

router.post(
  "/api/ai/generate-post-variations-from-url",
  requireAuth,
  blockExpiredTrial,
  express.json(),
  async (req, res) => {
    const { platforms, url } = req.body || {};
    if (!validatePlatforms(platforms)) {
      return res.status(400).json({ error: "invalid_platforms" });
    }
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: "invalid_url" });
    }

    let sourceText;
    try {
      sourceText = await fetchUrlText(url);
    } catch (err) {
      console.error(`[ai/generate-post-variations-from-url] fetch failed customerId=${req.customer.id} url=${url}:`, err);
      return res.status(400).json({ error: "url_fetch_failed" });
    }

    try {
      const results = await generatePostCopyVariations({ sourceText, platforms, url, count: VARIATION_COUNT });
      res.json({ results });
    } catch (err) {
      handleGenerationError(res, err, "[ai/generate-post-variations-from-url]", req.customer.id);
    }
  }
);

module.exports = router;
