// ダッシュボード「SNS連携」画面用の接続状況API。
// 上限判定・Dev Mode許可リスト判定はここで確定させ、フロント側では再計算しない
// （/oauth/{platform}/start のガード（src/middleware/snsConnectionGuard.js）と
// 判定ロジックを一致させること）。
const express = require("express");
const { requireAuth } = require("../middleware/requireAuth");
const { getConnectedEntry, deletePlatformTokensBySlug } = require("../lib/tokenStore");
const { planKey } = require("../lib/stripePricing");
const { getMaxConnections } = require("../lib/planLimitsConfig");
const { isPlatformAvailable } = require("../lib/snsConnectionModeConfig");

const router = express.Router();

const PLATFORMS = ["facebook", "instagram", "threads", "x"];

// facebookは複数ページを保持しうるため連結表示、他はusername（なければuser_id）を表示。
function accountNameFor(platform, tokenEntry) {
  if (platform === "facebook") {
    return (tokenEntry.pages || []).map((p) => p.pageName).join(", ") || null;
  }
  return tokenEntry.username || tokenEntry.user_id || null;
}

router.get("/api/sns-connections", requireAuth, (req, res) => {
  const customerId = req.customer.id;
  const entry = getConnectedEntry(customerId);
  const plan = planKey(req.customer);
  const maxConnections = getMaxConnections(plan);

  const platforms = {};
  let connectedCount = 0;
  for (const platform of PLATFORMS) {
    const tokenEntry = entry[platform];
    const connected = Boolean(tokenEntry);
    if (connected) connectedCount += 1;
    platforms[platform] = {
      connected,
      available: isPlatformAvailable(platform, customerId),
      ...(connected ? { accountName: accountNameFor(platform, tokenEntry) } : {}),
      // facebookは複数ページを連携しうるため、ワンショット投稿の投稿先ページ選択用に一覧を返す。
      ...(connected && platform === "facebook"
        ? { pages: (tokenEntry.pages || []).map((p) => ({ pageId: p.pageId, pageName: p.pageName })) }
        : {}),
    };
  }

  res.json({ plan, maxConnections, connectedCount, platforms });
});

router.post("/api/sns-connections/:platform/disconnect", requireAuth, (req, res) => {
  const { platform } = req.params;
  if (!PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: "invalid_platform" });
  }

  const removed = deletePlatformTokensBySlug(req.customer.id, platform);
  if (!removed) {
    return res.status(404).json({ error: "not_connected" });
  }
  res.json({ ok: true });
});

module.exports = router;
