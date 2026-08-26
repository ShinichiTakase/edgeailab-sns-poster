const express = require("express");
const {
  requireAuth,
  requireVerified,
  blockExpiredTrial,
  requireUnderTrialPostLimit,
  blockCanceledCustomer,
  blockViewerRole,
} = require("../middleware/requireAuth");
const { loadStore, accountNameFor } = require("../lib/tokenStore");
const { reportMeterEvent } = require("../lib/meterEvents");
const {
  createPostingLog,
  getActualPostCounts,
  listAllPostingLogsForCustomer,
} = require("../lib/postingLogStore");
const { createScheduledPost, listAllScheduledPostsForCustomer } = require("../lib/scheduledPostStore");
const { getStripe } = require("../lib/stripeClient");
const { getCurrentBillingCycle, getProjectedPostCounts } = require("../lib/billingCycle");
const retryStore = require("../lib/scheduledPostRetryStore");
const postingLogOriginStore = require("../lib/postingLogOriginStore");
const approvalStore = require("../lib/approvalStore");
const {
  bumpTrialPostCount,
  getTrialPostCount,
  crossedTrialPostLimitWarning,
  crossedTrialPostLimit,
  roleOf,
} = require("../lib/customerStore");
const { sendTrialPostLimitWarningIfNeeded } = require("../lib/trialPostLimitWarningMailer");
const { activateAfterTrialLimitIfNeeded, sendTrialPostLimitReachedEmailIfNeeded } = require("../lib/trialLimitAutoActivation");
const { containsUrl, extractFirstUrl } = require("../lib/urlDetection");
const xPoster = require("../lib/xPoster");
const facebookPoster = require("../lib/facebookPoster");
const instagramPoster = require("../lib/instagramPoster");
const threadsPoster = require("../lib/threadsPoster");
const linkedinPoster = require("../lib/linkedinPoster");

const router = express.Router();

const PLATFORMS = ["x", "threads", "facebook", "instagram", "linkedin"];

// imageUrlはInstagram投稿専用（UI上も「画像（Instagram投稿には必須）」として案内している）。
// Facebook/Threadsにまで同じ画像を渡すと写真投稿扱いになり、本文中のURLに対する
// og:imageリンクプレビューが表示されなくなるため、Instagram以外には渡さない。
async function postToPlatform(platform, entry, text, imageUrl, facebookPageId) {
  if (platform === "x") {
    return xPoster.postTextWithLinkImage(entry.access_token, text, extractFirstUrl(text), (err) => {
      console.error(`[posts] x link image attach failed:`, err);
    });
  }
  if (platform === "threads") {
    return threadsPoster.postText({ userId: entry.user_id, accessToken: entry.access_token }, text);
  }
  if (platform === "linkedin") {
    return linkedinPoster.postText({ personUrn: entry.user_id, accessToken: entry.access_token }, text, extractFirstUrl(text));
  }
  if (platform === "facebook") {
    const pages = entry.pages || [];
    const page = facebookPageId ? pages.find((p) => p.pageId === facebookPageId) : pages[0];
    if (!page) throw new Error("facebook_page_not_found");
    return facebookPoster.postText({ pageId: page.pageId, pageAccessToken: page.pageAccessToken }, text, extractFirstUrl(text));
  }
  if (platform === "instagram") {
    return instagramPoster.postImage({ igUserId: entry.user_id, accessToken: entry.access_token }, text, imageUrl);
  }
  throw new Error(`unknown platform: ${platform}`);
}

// platforms/texts共通バリデーション。即時投稿・予約投稿の両方から使う。
function validatePlatformsAndTexts(platforms, texts) {
  if (!Array.isArray(platforms) || platforms.length === 0 || platforms.some((p) => !PLATFORMS.includes(p))) {
    return "invalid_platforms";
  }
  if (typeof texts !== "object" || texts === null) {
    return "texts_required";
  }
  for (const platform of platforms) {
    if (typeof texts[platform] !== "string" || !texts[platform].trim()) {
      return "text_required";
    }
  }
  return null;
}

// 編集者の即時投稿・予約投稿を、実投稿の代わりにscheduled_postsへ承認待ちで作成する
// （即時投稿・予約投稿の両ルートから共有。プラットフォームごとに1レコード、
// 同一batch_idでひとつの承認対象単位とする。approvalStore.js参照）。
async function requestApprovalForOneShot(req, res, { platforms, texts, imageUrl, facebookPageId, store, scheduledAt }) {
  const approverIds = JSON.parse(req.user.approverIds || "[]");
  if (approverIds.length === 0) {
    return res.status(400).json({ error: "no_approver_configured" });
  }

  const customerId = req.customer.id;
  const results = {};
  const validPlatforms = [];
  for (const platform of platforms) {
    if (!store[platform]) {
      results[platform] = { ok: false, error: "not_connected" };
      continue;
    }
    if (platform === "facebook") {
      const pages = store.facebook.pages || [];
      const page = facebookPageId ? pages.find((p) => p.pageId === facebookPageId) : pages[0];
      if (!page) {
        results[platform] = { ok: false, error: "facebook_page_not_found" };
        continue;
      }
    }
    validPlatforms.push(platform);
  }
  if (validPlatforms.length === 0) {
    return res.json({ approvalRequested: false, results });
  }

  const approvalFields = approvalStore.buildApprovalFields(approverIds);
  for (const platform of validPlatforms) {
    const text = texts[platform];
    try {
      const created = await createScheduledPost({
        customerCode: customerId,
        createdBy: req.user.userId,
        platform,
        content: text,
        scheduledAt,
        containsUrl: containsUrl(text),
        imageUrl: platform === "instagram" ? imageUrl : undefined,
        facebookPageId: platform === "facebook" ? facebookPageId : undefined,
        approvalFields,
      });
      results[platform] = { ok: true, scheduledPostId: created.id, pendingApproval: true };
    } catch (err) {
      console.error(`[posts] approval request create failed platform=${platform} customerId=${customerId}:`, err);
      results[platform] = { ok: false, error: "schedule_failed" };
    }
  }

  const approvals = JSON.parse(approvalFields.approvals_json);
  const platformLabel = validPlatforms.join("/");
  const summary = `ワンショット投稿（${platformLabel}）: ${texts[validPlatforms[0]].slice(0, 60)}`;
  await approvalStore.sendApprovalRequestEmails({
    customer: req.customer,
    requesterUser: req.user,
    approvals,
    summary,
  });

  res.json({ approvalRequested: true, results });
}

router.post(
  "/api/posts",
  requireAuth,
  requireVerified,
  blockExpiredTrial,
  requireUnderTrialPostLimit,
  blockCanceledCustomer,
  blockViewerRole,
  express.json(),
  async (req, res) => {
    const { platforms, texts, imageUrl, facebookPageId } = req.body || {};

    const validationError = validatePlatformsAndTexts(platforms, texts);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    if (platforms.includes("instagram") && !imageUrl) {
      return res.status(400).json({ error: "instagram_image_required" });
    }

    const customerId = req.customer.id;
    const store = loadStore()[customerId] || {};
    const stripeCustomerId = req.customer.stripeCustomerId;

    // 編集者は実投稿を行わず、承認依頼を経由する（[投稿する]の代わりに[承認依頼]。
    // schedule-detail.jsの投稿文章バッチと同じ仕組み。承認完了後はscheduled_atが既に
    // 過去のためscheduledPostRunner.jsの次回tickで即実行される）。
    if (roleOf(req.user) === "編集者") {
      return requestApprovalForOneShot(req, res, { platforms, texts, imageUrl, facebookPageId, store, scheduledAt: new Date().toISOString() });
    }

    const results = {};
    let successCount = 0;

    for (const platform of platforms) {
      const entry = store[platform];
      if (!entry) {
        results[platform] = { ok: false, error: "not_connected" };
        continue;
      }

      const text = texts[platform];
      // Xサーチャージ対象かどうかは、プラットフォームごとの実際の投稿文に対して判定する
      // （SNSごとに文面が異なるため、共通の一括判定ではなく個別に判定する）。
      const textContainsUrl = containsUrl(text);

      let postResult;
      try {
        postResult = await postToPlatform(platform, entry, text, imageUrl, facebookPageId);
      } catch (err) {
        console.error(`[posts] platform=${platform} customerId=${customerId} post failed:`, err);
        // Instagram側のメディア処理待ちタイムアウトは、単純な投稿失敗と区別できるよう
        // 専用のエラーコードにする（instagramPoster.jsのwaitForContainerReady参照）。
        const isInstagramTimeout = err.message && err.message.startsWith("instagram_processing_timeout");
        results[platform] = { ok: false, error: isInstagramTimeout ? "instagram_processing_timeout" : "post_failed" };
        continue;
      }

      // メーターイベント送信・投稿ログ記録の失敗は投稿自体の成否に影響させない
      // （投稿は既に成功しているため。x.jsの既存パターンを踏襲）。
      let meterEventSent = false;
      try {
        await reportMeterEvent("post_created", stripeCustomerId);
        if (platform === "x" && textContainsUrl) {
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
          containsUrl: textContainsUrl,
          meterEventSent,
          accountName: accountNameFor(platform, entry),
        });
      } catch (err) {
        console.error(`[posts] posting log write failed customerId=${customerId} platform=${platform}:`, err);
      }

      successCount += 1;
      results[platform] = { ok: true, id: postResult.id };
    }

    // トライアル投稿数の加算はループ終了後に一度だけ行う（customerStore.bumpTrialPostCount参照）。
    if (successCount > 0) {
      try {
        const before = getTrialPostCount(req.customer);
        const after = await bumpTrialPostCount(customerId, req.customer, successCount);
        // 投稿上限（60通）の80%到達を今回の加算で初めて跨いだ場合のみ即時メール送信
        // （trialPostLimitWarningMailer.js参照。送信失敗・支払い方法登録済みでの
        // スキップは投稿処理自体の成否に影響させない）。
        if (crossedTrialPostLimitWarning(req.customer, before, after)) {
          await sendTrialPostLimitWarningIfNeeded({
            customer: { ...req.customer, trialPostCount: after },
            logger: { logError: (...args) => console.error(...args) },
          });
        }
        // 投稿上限（60通）そのものを今回の加算で初めて跨いだ場合、支払い方法登録済み
        // なら即時本稼働へ切り替え・課金開始する（trialLimitAutoActivation.js参照。
        // 未登録の場合は何もせず、requireUnderTrialPostLimitによる次回以降のブロックが
        // そのまま効く）。
        if (crossedTrialPostLimit(req.customer, before, after)) {
          const activationResult = await activateAfterTrialLimitIfNeeded({
            customer: { ...req.customer, trialPostCount: after },
            logger: { logError: (...args) => console.error(...args) },
          });
          await sendTrialPostLimitReachedEmailIfNeeded({
            customer: { ...req.customer, trialPostCount: after },
            result: activationResult,
            logger: { logError: (...args) => console.error(...args) },
          });
        }
      } catch (err) {
        console.error(`[posts] trial post count update failed customerId=${customerId}:`, err);
      }
    }

    res.json({ results });
  }
);

// 予約投稿。実際の投稿・課金は行わず、scheduled_postsにstatus=pendingでレコードを作成するのみ
// （予約投稿の実行エンジン＝cronはこのプロジェクトにまだ存在しない。予約時点でトライアル投稿数を
// 消費する設計は、実行時カウントが技術的に不可能なための現実的な選択）。
router.post(
  "/api/posts/schedule",
  requireAuth,
  requireVerified,
  blockExpiredTrial,
  requireUnderTrialPostLimit,
  blockCanceledCustomer,
  blockViewerRole,
  express.json(),
  async (req, res) => {
    const { platforms, texts, imageUrl, facebookPageId, scheduledAt } = req.body || {};

    const validationError = validatePlatformsAndTexts(platforms, texts);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    if (platforms.includes("instagram") && !imageUrl) {
      return res.status(400).json({ error: "instagram_image_required" });
    }
    const scheduledDate = typeof scheduledAt === "string" ? new Date(scheduledAt) : null;
    if (!scheduledDate || Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
      return res.status(400).json({ error: "invalid_scheduled_at" });
    }

    const customerId = req.customer.id;
    const store = loadStore()[customerId] || {};

    // 編集者は承認依頼を経由する（即時投稿と同様。選択した予約時刻はそのまま保持し、
    // 承認完了時刻とどちらか遅い方で実行される＝scheduledPostRunner.jsの通常ロジックに従う）。
    if (roleOf(req.user) === "編集者") {
      return requestApprovalForOneShot(req, res, {
        platforms,
        texts,
        imageUrl,
        facebookPageId,
        store,
        scheduledAt: scheduledDate.toISOString(),
      });
    }

    const results = {};
    let successCount = 0;

    for (const platform of platforms) {
      if (!store[platform]) {
        results[platform] = { ok: false, error: "not_connected" };
        continue;
      }
      // facebookは複数ページ連携時にfacebookPageIdの指定が必要（即時投稿と同じ制約）。
      if (platform === "facebook") {
        const pages = store.facebook.pages || [];
        const page = facebookPageId ? pages.find((p) => p.pageId === facebookPageId) : pages[0];
        if (!page) {
          results[platform] = { ok: false, error: "facebook_page_not_found" };
          continue;
        }
      }

      const text = texts[platform];
      const textContainsUrl = containsUrl(text);

      try {
        const created = await createScheduledPost({
          customerCode: customerId,
          createdBy: req.user.userId,
          platform,
          content: text,
          scheduledAt: scheduledDate.toISOString(),
          containsUrl: textContainsUrl,
          imageUrl: platform === "instagram" ? imageUrl : undefined,
          facebookPageId: platform === "facebook" ? facebookPageId : undefined,
        });
        successCount += 1;
        results[platform] = { ok: true, scheduledPostId: created.id };
      } catch (err) {
        console.error(`[posts/schedule] platform=${platform} customerId=${customerId} failed:`, err);
        results[platform] = { ok: false, error: "schedule_failed" };
      }
    }

    if (successCount > 0) {
      try {
        const before = getTrialPostCount(req.customer);
        const after = await bumpTrialPostCount(customerId, req.customer, successCount);
        if (crossedTrialPostLimitWarning(req.customer, before, after)) {
          await sendTrialPostLimitWarningIfNeeded({
            customer: { ...req.customer, trialPostCount: after },
            logger: { logError: (...args) => console.error(...args) },
          });
        }
        if (crossedTrialPostLimit(req.customer, before, after)) {
          const activationResult = await activateAfterTrialLimitIfNeeded({
            customer: { ...req.customer, trialPostCount: after },
            logger: { logError: (...args) => console.error(...args) },
          });
          await sendTrialPostLimitReachedEmailIfNeeded({
            customer: { ...req.customer, trialPostCount: after },
            result: activationResult,
            logger: { logError: (...args) => console.error(...args) },
          });
        }
      } catch (err) {
        console.error(`[posts/schedule] trial post count update failed customerId=${customerId}:`, err);
      }
    }

    res.json({ results });
  }
);

const PLATFORM_DISPLAY_LABELS = { x: "X", threads: "Threads", facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn" };

function platformDisplayLabel(value) {
  const key = Array.isArray(value) ? value[0] : value;
  return PLATFORM_DISPLAY_LABELS[key] || key || "";
}

// 投稿一覧画面用。即時投稿（posting_logs）と予約投稿（scheduled_posts）を横断して
// 顧客自身の全件を返す（他customerのデータは返さない。IDOR対策はposts.js全体の方針に合わせる）。
router.get("/api/posts/list", requireAuth, async (req, res) => {
  const customerCode = req.customer.id;
  const emailByUserId = new Map();
  for (const user of req.customer.users || []) {
    emailByUserId.set(user.userId, user.email);
  }

  try {
    const [postingLogs, scheduledPosts] = await Promise.all([
      listAllPostingLogsForCustomer(customerCode),
      listAllScheduledPostsForCustomer(customerCode),
    ]);

    const rows = [];

    for (const log of postingLogs) {
      rows.push({
        postDateTime: log.createdAt,
        email: emailByUserId.get(log.created_by) || null,
        platform: platformDisplayLabel(log.platform),
        accountName: log.account_name || null,
        content: log.content || "",
        scheduledAt: null,
        // 予約投稿が実行された結果のposting_logs（postingLogOriginStore.js）は、この列で
        // 「即時」と表示すべきではない（予定日時列に「即時」と表示するのは真の即時投稿のみ。
        // post-list.html参照）。
        isImmediate: !postingLogOriginStore.isFromScheduledPost(log.id),
        completedAt: log.posted_at || log.createdAt,
        // posting_logsは投稿成功時にしか作られないため常に成功扱い。
        result: "success",
      });
    }

    for (const post of scheduledPosts) {
      const status = Array.isArray(post.status) ? post.status[0] : post.status;
      // status=doneのものは、実行時に作られたposting_logs側（上のループ）に既に同じ投稿が
      // 記録されているため、ここで重複して行を作らない（重複表示防止）。
      if (status === "done") continue;
      // failedは再試行の余地（scheduledPostRetryStore.js）が残っているかどうかで
      // 「再試行」/「失敗」を出し分ける。
      const result = status === "failed" ? retryStore.getDisplayState(post.id) : "pending";
      rows.push({
        // 投稿日時＝この予約（一括生成分含む）が作成された日時。実際に投稿された日時は
        // 投稿完了時間（completedAt）が担う。2列を混同しないよう役割を分離している。
        postDateTime: post.createdAt,
        email: emailByUserId.get(post.created_by) || null,
        platform: platformDisplayLabel(post.platform),
        // 実際に投稿が完了していないため、投稿先アカウントはまだ確定しない
        // （posting_logs側の行のみaccountNameを持つ）。
        accountName: null,
        content: post.content || "",
        // 予約日時は実行前の目安表示のためのもの。投稿完了後は役目を終えるためブランクにする。
        scheduledAt: status === "pending" ? post.scheduled_at : null,
        isImmediate: false,
        completedAt: status === "pending" ? null : post.updatedAt,
        result,
      });
    }

    rows.sort((a, b) => new Date(b.postDateTime) - new Date(a.postDateTime));
    res.json({ rows });
  } catch (err) {
    console.error(`[posts/list] failed customerId=${customerCode}:`, err);
    res.status(500).json({ error: "internal_error" });
  }
});

// customerIdはクエリパラメータではなく、他の /api/posts/* 同様requireAuthが設定する
// req.customer.id（認証済み本人のみ）を使う。クライアント指定のcustomerIdをそのまま
// 信用すると他customerのデータを覗けてしまう（IDOR）ため、既存エンドポイントの
// セキュリティ方針に合わせている。
//
// 月選択パラメータは持たない（2026-08-26設計変更）。常に「今、進行中の周期」の
// 実績（前回決算日〜今日）だけを返す（billing.js の /api/billing/upcoming と同じ
// billingCycle.getCurrentBillingCycleを使い、周期の求め方を1箇所に集約）。
router.get("/api/posts/stats", requireAuth, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: "stripe_not_configured" });
  }

  const emptyCounts = { x: 0, threads: 0, facebook: 0, instagram: 0, linkedin: 0 };

  try {
    const cycle = await getCurrentBillingCycle(stripe, req.customer);
    if (!cycle || !cycle.cycleStart) {
      return res.json({ counts: emptyCounts, periodStart: null, periodEnd: null });
    }

    const now = new Date();
    const counts = await getActualPostCounts(req.customer.id, cycle.cycleStart, now);
    res.json({ counts: counts.counts, periodStart: cycle.cycleStart.toISOString(), periodEnd: now.toISOString() });
  } catch (err) {
    console.error(`[posts/stats] failed customerId=${req.customer.id}:`, err);
    res.status(500).json({ error: "internal_error" });
  }
});

// customerIdはクエリパラメータではなく、他の /api/posts/* 同様requireAuthが設定する
// req.customer.id（認証済み本人のみ）を使う（IDOR対策）。
//
// 月選択パラメータは持たない。常に「今、進行中の周期」の予定（今日〜次回決算日、
// 未実行かつスケジュール設定済みの投稿のみ）を返す（2026-08-26復活。billing.jsの
// /api/billing/upcomingと同じbillingCycle.getCurrentBillingCycle/getProjectedPostCounts
// を使い、周期・投稿数の求め方を1箇所に集約）。
router.get("/api/posts/scheduled", requireAuth, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: "stripe_not_configured" });
  }

  const emptyCounts = { x: 0, threads: 0, facebook: 0, instagram: 0, linkedin: 0 };

  try {
    const cycle = await getCurrentBillingCycle(stripe, req.customer);
    if (!cycle) {
      return res.json({ counts: emptyCounts, xUrlCount: 0, periodStart: null, periodEnd: null });
    }

    const now = new Date();
    const projected = await getProjectedPostCounts(req.customer, now, cycle.cycleEnd);
    res.json({
      counts: projected.counts,
      xUrlCount: projected.xUrlCount,
      periodStart: now.toISOString(),
      periodEnd: cycle.cycleEnd.toISOString(),
    });
  } catch (err) {
    console.error(`[posts/scheduled] failed customerId=${req.customer.id}:`, err);
    res.status(500).json({ error: "internal_error" });
  }
});

module.exports = router;
