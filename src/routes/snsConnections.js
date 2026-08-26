// ダッシュボード「SNS連携」画面用の接続状況API。
// 上限判定・Dev Mode許可リスト判定はここで確定させ、フロント側では再計算しない
// （/oauth/{platform}/start のガード（src/middleware/snsConnectionGuard.js）と
// 判定ロジックを一致させること）。
const express = require("express");
const { requireAuth, blockViewerRole, blockEditorRole } = require("../middleware/requireAuth");
const { getConnectedEntry, deletePlatformTokensBySlug, accountNameFor } = require("../lib/tokenStore");
const { planKey } = require("../lib/stripePricing");
const { getMaxConnections } = require("../lib/planLimitsConfig");
const { isPlatformAvailable } = require("../lib/snsConnectionModeConfig");
const { listPendingByCustomerAndPlatform, deleteScheduledPost } = require("../lib/scheduledPostStore");
const { createLogger } = require("../lib/logger");

const router = express.Router();
// 「削除」操作の監査ログ。instagram.js/facebook.js等のOAuthコールバックはinstagram.log等に
// 連携完了を記録しているが、連携解除（このファイル）側には記録が一切なかったため、
// 「本当に削除ボタンを押したのか」を事後に確認できるよう追加した。
const { logInfo, logError } = createLogger("sns-connections.log");

const PLATFORMS = ["facebook", "instagram", "threads", "x", "linkedin"];

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

router.post("/api/sns-connections/:platform/disconnect", requireAuth, blockViewerRole, blockEditorRole, async (req, res) => {
  const { platform } = req.params;
  if (!PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: "invalid_platform" });
  }

  const slug = req.customer.id;
  const beforeEntry = getConnectedEntry(slug)[platform];
  const removed = deletePlatformTokensBySlug(slug, platform);
  if (!removed) {
    return res.status(404).json({ error: "not_connected" });
  }
  const accountName = beforeEntry ? accountNameFor(platform, beforeEntry) : null;
  logInfo(`[sns-connections/disconnect] slug=${slug} platform=${platform} account=${accountName || "unknown"} by=${req.user.userId}`);

  // 連携解除した1プラットフォーム宛ての未実行予約（スケジュール投稿由来・ワンショット予約
  // 由来の両方を含む）を取り消す。放置すると、トークンが無いまま実行時に
  // scheduledPostExecutor.jsが失敗し続ける（アカウント解約時のcancelScheduledJobsForCustomer
  // と同じ考え方だが、こちらは全プラットフォーム一括ではなく1プラットフォームのみが対象）。
  // 429対策のため1件ずつ順次削除（他のキャンセル処理と同じパターン）。
  let canceledScheduledPostCount = 0;
  try {
    const pending = await listPendingByCustomerAndPlatform(slug, platform);
    for (const post of pending) {
      await deleteScheduledPost(post.id);
      canceledScheduledPostCount += 1;
    }
    if (canceledScheduledPostCount > 0) {
      logInfo(`[sns-connections/disconnect] slug=${slug} platform=${platform} canceled ${canceledScheduledPostCount} pending scheduled post(s)`);
    }
  } catch (err) {
    logError(`[sns-connections/disconnect] slug=${slug} platform=${platform} pending post cancellation failed:`, err);
  }

  res.json({ ok: true, canceledScheduledPostCount });
});

module.exports = router;
