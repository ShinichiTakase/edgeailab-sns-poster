// ダッシュボード「SNS連携」画面用の接続状況API。
// 上限判定・Dev Mode許可リスト判定はここで確定させ、フロント側では再計算しない
// （/oauth/{platform}/start のガード（src/middleware/snsConnectionGuard.js）と
// 判定ロジックを一致させること）。
const express = require("express");
const crypto = require("crypto");
const { requireAuth, blockViewerRole, blockEditorRole, blockApproverRole } = require("../middleware/requireAuth");
const { getConnectedEntry, deletePlatformTokensBySlug, savePlatformTokens, accountNameFor } = require("../lib/tokenStore");
const { planKey } = require("../lib/stripePricing");
const { getMaxConnections } = require("../lib/planLimitsConfig");
const { isPlatformAvailable } = require("../lib/snsConnectionModeConfig");
const { listPendingByCustomerAndPlatform, deleteScheduledPost } = require("../lib/scheduledPostStore");
const { createLogger } = require("../lib/logger");
const pkceStore = require("../lib/pkceStore");
const { recordConnectionForHistory, revokeTrialAfterHistoryReconnect } = require("../lib/trialHistoryGuard");

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

router.post("/api/sns-connections/:platform/disconnect", requireAuth, blockViewerRole, blockEditorRole, blockApproverRole, async (req, res) => {
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

// SNS連携履歴（sns_history.json）との照合でヒットした場合（instagram.js/x.js/threads.js/
// linkedin.js/facebook.jsのOAuthコールバック参照）に表示する確認ダイアログの「連携」を
// 確定するエンドポイント。「キャンセル」を選んだ場合はここを呼ばず、pkceStoreに一時保管
// したトークンはTTL（10分）で自然に失効させるだけでよい。
//
// Instagramのみ、ここでの確定後にさらに既存の「アカウント切替確認」フローへ引き継ぐ
// ケースがある（現在の連携先と別アカウントに切り替える、かつ切替先がsns_history.json
// にもヒットしていた場合）。その場合はトークン保存・トライアル失効のいずれもここでは
// 行わず、instagram.jsの/api/instagram/confirm-switch側（本人が2段階目の確認も完了した
// 時点）まで遅延させる。理由: 2段階目を「キャンセル」された場合に、実際には何も連携
// していないのにトライアルだけを失うバグを避けるため（詳細はtrialHistoryGuard.js参照）。
router.post("/api/sns-connections/confirm-trial-history-reconnect", requireAuth, blockViewerRole, blockEditorRole, blockApproverRole, express.json(), async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "token_required" });

  const pending = pkceStore.take(token);
  if (!pending || pending.slug !== req.customer.id) {
    return res.status(400).json({ error: "invalid_or_expired_token" });
  }

  const { platform, tokenData, identifiers } = pending;

  if (platform === "instagram") {
    const existing = getConnectedEntry(pending.slug).instagram;
    if (existing && existing.user_id !== tokenData.user_id) {
      const switchToken = crypto.randomBytes(24).toString("hex");
      pkceStore.put(switchToken, { slug: pending.slug, tokenData, trialHistoryIdentifiers: identifiers });
      logInfo(
        `[sns-connections/confirm-trial-history-reconnect] slug=${pending.slug} platform=instagram needs switch confirm too (from=${existing.username || existing.user_id} to=${tokenData.username})`
      );
      return res.json({
        ok: true,
        needsSwitchConfirm: true,
        switchToken,
        from: existing.username || existing.user_id,
        to: tokenData.username,
      });
    }
  }

  savePlatformTokens(pending.slug, platform, tokenData);
  await revokeTrialAfterHistoryReconnect(pending.slug);
  await recordConnectionForHistory(platform, identifiers, pending.slug, new Date().toISOString());

  logInfo(
    `[sns-connections/confirm-trial-history-reconnect] slug=${pending.slug} platform=${platform} confirmed, trial revoked by=${req.user.userId}`
  );
  res.json({ ok: true });
});

module.exports = router;
