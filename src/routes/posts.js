const express = require("express");
const {
  requireAuth,
  requireVerified,
  blockExpiredTrial,
  requireUnderTrialPostLimit,
  blockCanceledCustomer,
} = require("../middleware/requireAuth");
const { loadStore } = require("../lib/tokenStore");
const { reportMeterEvent } = require("../lib/meterEvents");
const { createPostingLog, getPostStatsForCustomer } = require("../lib/postingLogStore");
const { updateCustomer, getTrialPostCount } = require("../lib/customerStore");
const xPoster = require("../lib/xPoster");
const facebookPoster = require("../lib/facebookPoster");
const instagramPoster = require("../lib/instagramPoster");
const threadsPoster = require("../lib/threadsPoster");

const router = express.Router();

const PLATFORMS = ["x", "threads", "facebook", "instagram"];
// URLを含む投稿のみXサーチャージ対象（誤検知を避けるためプロトコル省略記法は対象外）。X専用。
const URL_PATTERN = /https?:\/\//;

async function postToPlatform(platform, entry, text, imageUrl, facebookPageId) {
  if (platform === "x") {
    return xPoster.postText(entry.access_token, text);
  }
  if (platform === "threads") {
    return threadsPoster.postText({ userId: entry.user_id, accessToken: entry.access_token }, text, imageUrl);
  }
  if (platform === "facebook") {
    const pages = entry.pages || [];
    const page = facebookPageId ? pages.find((p) => p.pageId === facebookPageId) : pages[0];
    if (!page) throw new Error("facebook_page_not_found");
    return facebookPoster.postText({ pageId: page.pageId, pageAccessToken: page.pageAccessToken }, text, imageUrl);
  }
  if (platform === "instagram") {
    return instagramPoster.postImage({ igUserId: entry.user_id, accessToken: entry.access_token }, text, imageUrl);
  }
  throw new Error(`unknown platform: ${platform}`);
}

router.post(
  "/api/posts",
  requireAuth,
  requireVerified,
  blockExpiredTrial,
  requireUnderTrialPostLimit,
  blockCanceledCustomer,
  express.json(),
  async (req, res) => {
    const { platforms, text, imageUrl, facebookPageId } = req.body || {};

    if (!Array.isArray(platforms) || platforms.length === 0 || platforms.some((p) => !PLATFORMS.includes(p))) {
      return res.status(400).json({ error: "invalid_platforms" });
    }
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "text_required" });
    }
    if (platforms.includes("instagram") && !imageUrl) {
      return res.status(400).json({ error: "instagram_image_required" });
    }

    const customerId = req.customer.id;
    const store = loadStore()[customerId] || {};
    const containsUrl = URL_PATTERN.test(text);
    const stripeCustomerId = req.customer.stripeCustomerId;

    const results = {};
    let successCount = 0;

    for (const platform of platforms) {
      const entry = store[platform];
      if (!entry) {
        results[platform] = { ok: false, error: "not_connected" };
        continue;
      }

      let postResult;
      try {
        postResult = await postToPlatform(platform, entry, text, imageUrl, facebookPageId);
      } catch (err) {
        console.error(`[posts] platform=${platform} customerId=${customerId} post failed:`, err);
        results[platform] = { ok: false, error: "post_failed" };
        continue;
      }

      // メーターイベント送信・投稿ログ記録の失敗は投稿自体の成否に影響させない
      // （投稿は既に成功しているため。x.jsの既存パターンを踏襲）。
      let meterEventSent = false;
      try {
        await reportMeterEvent("post_created", stripeCustomerId);
        if (platform === "x" && containsUrl) {
          await reportMeterEvent("x_surcharge_post", stripeCustomerId);
        }
        meterEventSent = true;
      } catch (err) {
        console.error(`[posts] meter event failed customerId=${customerId} platform=${platform}:`, err);
      }

      try {
        await createPostingLog({
          customerCode: customerId,
          createdBy: req.user.userId,
          platform,
          content: text,
          platformPostId: postResult.id,
          containsUrl,
          meterEventSent,
        });
      } catch (err) {
        console.error(`[posts] posting log write failed customerId=${customerId} platform=${platform}:`, err);
      }

      successCount += 1;
      results[platform] = { ok: true, id: postResult.id };
    }

    // トライアル投稿数の加算はループ終了後に一度だけ行う。ループ内で都度
    // incrementTrialPostCountを呼ぶと、req.customerの値が更新されないまま
    // 同じ古い値+1を複数回書き込んでしまう（成功件数分が積み上がらない）ため。
    if (successCount > 0) {
      try {
        await updateCustomer(customerId, { trialPostCount: getTrialPostCount(req.customer) + successCount });
      } catch (err) {
        console.error(`[posts] trial post count update failed customerId=${customerId}:`, err);
      }
    }

    res.json({ results });
  }
);

router.get("/api/posts/stats", requireAuth, async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: "invalid_year_month" });
  }
  try {
    const counts = await getPostStatsForCustomer(req.customer.id, year, month);
    res.json(counts);
  } catch (err) {
    console.error(`[posts/stats] failed customerId=${req.customer.id}:`, err);
    res.status(500).json({ error: "internal_error" });
  }
});

module.exports = router;
