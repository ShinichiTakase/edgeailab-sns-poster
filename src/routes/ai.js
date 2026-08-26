const express = require("express");
const { requireAuth, blockExpiredTrial, blockViewerRole, blockApproverRole } = require("../middleware/requireAuth");
const { generatePostCopy, generatePostCopyVariations } = require("../lib/postCopyGenerator");
const { fetchUrlText } = require("../lib/urlTextFetcher");
const { classifyFetchError, classifyGenerationError } = require("../lib/generationErrors");
const { getDocsNumber } = require("../lib/generationConfig");

const router = express.Router();

const PLATFORMS = ["x", "threads", "facebook", "instagram", "linkedin"];

function validatePlatforms(platforms) {
  return Array.isArray(platforms) && platforms.length > 0 && platforms.every((p) => PLATFORMS.includes(p));
}

function handleGenerationError(res, err, logPrefix, customerId) {
  const { code, status } = classifyGenerationError(err);
  console.error(`${logPrefix} customerId=${customerId} failed (${code}):`, err);
  return res.status(status).json({ error: code });
}

function handleFetchError(res, err, logPrefix, customerId, url) {
  const { code } = classifyFetchError(err);
  console.error(`${logPrefix} fetch failed (${code}) customerId=${customerId} url=${url}:`, err);
  return res.status(400).json({ error: code });
}

// フロントエンド（schedule-detail.htmlの「投稿文章を追加」画面）が、AI生成の候補数
// （DOCS_NUMBER、ラウンドロビン用テキストエリア・Instagram動画スロットの描画数と
// 一致させる必要がある）を取得するための設定エンドポイント。認証済みであれば
// 誰でも参照可（機密情報を含まないため）。
router.get("/api/ai/config", requireAuth, (req, res) => {
  res.json({ variationCount: getDocsNumber() });
});

// 原文（URL未使用）からAI文案生成。投稿自体ではないためトライアル投稿数上限は関係ない。
// メール認証未完了でも文案作成自体は試せるようにする（ブロックするのは実際の投稿・予約のみ）。
router.post("/api/ai/generate-post", requireAuth, blockExpiredTrial, blockViewerRole, blockApproverRole, express.json(), async (req, res) => {
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
  blockViewerRole, blockApproverRole,
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
      return handleFetchError(res, err, "[ai/generate-post-from-url]", req.customer.id, url);
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
// getDocsNumber()件の異なる文案をまとめて生成する（ラウンドロビン投稿での連続投稿が
// 似た文面にならないようにするため）。
router.post(
  "/api/ai/generate-post-variations",
  requireAuth,
  blockExpiredTrial,
  blockViewerRole, blockApproverRole,
  express.json(),
  async (req, res) => {
    const __routeT0 = Date.now();
    const { platforms, sourceText } = req.body || {};
    if (!validatePlatforms(platforms)) {
      return res.status(400).json({ error: "invalid_platforms" });
    }
    if (typeof sourceText !== "string" || !sourceText.trim()) {
      return res.status(400).json({ error: "source_text_required" });
    }

    try {
      const results = await generatePostCopyVariations({ sourceText, platforms, count: getDocsNumber() });
      console.log(
        `[timing] ai/generate-post-variations platforms=${platforms.join(",")} totalMs=${Date.now() - __routeT0}`
      );
      res.json({ results });
    } catch (err) {
      console.log(`[timing] ai/generate-post-variations FAILED totalMs=${Date.now() - __routeT0}`);
      handleGenerationError(res, err, "[ai/generate-post-variations]", req.customer.id);
    }
  }
);

router.post(
  "/api/ai/generate-post-variations-from-url",
  requireAuth,
  blockExpiredTrial,
  blockViewerRole, blockApproverRole,
  express.json(),
  async (req, res) => {
    // 体感速度の遅さの原因切り分け調査用（2026-08-20）。fetch・AI生成・リクエスト全体
    // それぞれの所要時間を分けて記録する。
    const __routeT0 = Date.now();
    const { platforms, url } = req.body || {};
    if (!validatePlatforms(platforms)) {
      return res.status(400).json({ error: "invalid_platforms" });
    }
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: "invalid_url" });
    }

    let sourceText;
    const __fetchT0 = Date.now();
    try {
      sourceText = await fetchUrlText(url);
    } catch (err) {
      console.log(`[timing] ai/generate-post-variations-from-url fetch failed after fetchMs=${Date.now() - __fetchT0}`);
      return handleFetchError(res, err, "[ai/generate-post-variations-from-url]", req.customer.id, url);
    }
    const __fetchMs = Date.now() - __fetchT0;

    const __genT0 = Date.now();
    try {
      const results = await generatePostCopyVariations({ sourceText, platforms, url, count: getDocsNumber() });
      const __genMs = Date.now() - __genT0;
      console.log(
        `[timing] ai/generate-post-variations-from-url platforms=${platforms.join(",")} ` +
          `fetchMs=${__fetchMs} genMs=${__genMs} totalMs=${Date.now() - __routeT0}`
      );
      res.json({ results });
    } catch (err) {
      console.log(
        `[timing] ai/generate-post-variations-from-url FAILED fetchMs=${__fetchMs} genMs=${Date.now() - __genT0} totalMs=${Date.now() - __routeT0}`
      );
      handleGenerationError(res, err, "[ai/generate-post-variations-from-url]", req.customer.id);
    }
  }
);

module.exports = router;
