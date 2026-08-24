// scheduled_posts 1件を実際にSNSへ投稿する処理本体。scheduledPostRunner.js（初回実行）と
// scheduledPostRetryRunner.js（再試行）の両方から共有で使う。
// 失敗時はstatus更新を行わずに例外をthrowする（呼び出し側が初回失敗/再試行失敗それぞれの
// カウント管理・status更新を担うため）。
const { markScheduledPostStatus, PLATFORM_LABELS } = require("./scheduledPostStore");
const { createPostingLog } = require("./postingLogStore");
const postingLogOriginStore = require("./postingLogOriginStore");
const { loadStore, accountNameFor } = require("./tokenStore");
const {
  getCustomerById,
  isTrialPostLimitReached,
  isCanceled,
  bumpTrialPostCount,
  getTrialPostCount,
  crossedTrialPostLimitWarning,
} = require("./customerStore");
const { reportMeterEvent } = require("./meterEvents");
const { containsUrl, extractFirstUrl } = require("./urlDetection");
const scheduleStore = require("./scheduleStore");
const { sendScheduleResultEmail } = require("./scheduleResultMailer");
const { sendTrialPostLimitWarningIfNeeded } = require("./trialPostLimitWarningMailer");
const xPoster = require("./xPoster");
const facebookPoster = require("./facebookPoster");
const instagramPoster = require("./instagramPoster");
const threadsPoster = require("./threadsPoster");
const linkedinPoster = require("./linkedinPoster");

function platformKeyFromLabel(value) {
  const label = Array.isArray(value) ? value[0] : value;
  return Object.keys(PLATFORM_LABELS).find((k) => PLATFORM_LABELS[k] === label) || null;
}

// posts.jsのpostToPlatformと同じ方針：imageUrl/videoUrlはInstagramにのみ渡す
// （Facebook/Threadsに渡すと写真投稿扱いになりog:imageリンクプレビューが出なくなるため）。
// Instagramはvideo_urlがあればリール投稿、なければ従来通り画像投稿にフォールバックする。
async function postToPlatform(platform, entry, text, imageUrl, videoUrl, facebookPageId, logger) {
  if (platform === "x") {
    return xPoster.postTextWithLinkImage(entry.access_token, text, extractFirstUrl(text), (err) => {
      logger.logError(`[scheduledPostExecutor] x link image attach failed:`, err);
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
    const igEntry = { igUserId: entry.user_id, accessToken: entry.access_token };
    if (videoUrl) return instagramPoster.postReel(igEntry, text, videoUrl);
    return instagramPoster.postImage(igEntry, text, imageUrl);
  }
  throw new Error(`unknown_platform:${platform}`);
}

/**
 * scheduled_posts 1件を実際にSNSへ投稿する。成功時はstatus="done"に更新し、即時投稿と同じく
 * posting_logsへの記録・Stripeメーターイベント送信を行う（送信失敗はログのみで投稿自体の
 * 成否には影響させない。元のscheduledPostRunner.jsの挙動を踏襲）。
 * 失敗時（SNS投稿自体が失敗した場合）は例外をthrowする。status更新・再試行回数の記録は
 * 呼び出し側の責務。
 * @param {object} post scheduled_postsの1レコード
 * @param {Map} customerCache customer_code -> customer のキャッシュ（呼び出し元で使い回す）
 * @param {{logError: Function}} logger 部分的な失敗（メーター送信・ログ書き込み）を記録する
 */
async function attemptScheduledPost(post, customerCache, logger) {
  const platform = platformKeyFromLabel(post.platform);
  const customerCode = post.customer_code;
  if (!platform) throw new Error(`invalid_platform_value:${JSON.stringify(post.platform)}`);

  if (!customerCache.has(customerCode)) {
    customerCache.set(customerCode, await getCustomerById(customerCode));
  }
  const customer = customerCache.get(customerCode);
  if (!customer) throw new Error("customer_not_found");

  // ワンショット投稿（posts.js）と同じガード。cronはHTTPリクエストの文脈を持たないため、
  // requireAuth.jsのミドルウェアではなくcustomerStore.jsの純粋関数を直接呼ぶ。
  if (isCanceled(customer)) throw new Error("account_canceled");
  if (isTrialPostLimitReached(customer)) throw new Error("trial_post_limit_reached");

  const tokenEntry = (loadStore()[customerCode] || {})[platform];
  if (!tokenEntry) throw new Error("not_connected");

  const postResult = await postToPlatform(
    platform,
    tokenEntry,
    post.content || "",
    post.image_url,
    post.video_url,
    post.facebook_page_id || null,
    logger
  );

  await markScheduledPostStatus(post.id, "done");

  // スケジュール投稿（post_schedules）由来の予約のみ対象。ワンショット投稿ウィザードからの
  // 直接予約はsource_schedule_idが空のため対象外（notify_emailはpost_schedules側の設定のため）。
  if (post.source_schedule_id) {
    // トライアル投稿数のカウント（2026-08-25追加）。ワンショット投稿（posts.js）は
    // POST /api/posts/schedule の作成時点で既にbumpTrialPostCount済みのため、ここで
    // 二重加算しないようsource_schedule_idがある（＝継続スケジュール由来の）投稿のみを
    // 対象にする。継続スケジュールは予約作成時点（scheduleMaterializer.js）では
    // カウントできず（何通生成されるかは曜日・時間帯設定に依存し予約作成＝投稿確定
    // ではないため）、実行成功時にカウントする以外に方法が無い。
    // これが無いと、post_schedules経由の投稿がtrialPostCountに一切反映されず、
    // isTrialPostLimitReached()が機能しないままトライアル顧客が無制限に投稿できて
    // しまう不具合があった（実機で確認: shin.takase@icloud.com、2026-08-25）。
    try {
      const beforeCount = getTrialPostCount(customer);
      const nextCount = await bumpTrialPostCount(customerCode, customer, 1);
      // customerCacheは呼び出し元（scheduledPostRunner.js等）が同一cron実行内で使い回すため、
      // ここで更新しておかないと同一顧客の後続投稿が古いtrialPostCountのまま
      // isTrialPostLimitReached判定を通ってしまう（同一バッチ内での二重カウント漏れ防止）。
      customer.trialPostCount = nextCount;
      // 投稿上限（60通）の80%到達を今回の加算で初めて跨いだ場合のみ即時メール送信
      // （posts.jsの即時投稿・ワンショット予約投稿と同じロジックを継続スケジュール
      // 投稿にも適用。trialPostLimitWarningMailer.js参照）。
      if (crossedTrialPostLimitWarning(customer, beforeCount, nextCount)) {
        await sendTrialPostLimitWarningIfNeeded({ customer, logger });
      }
    } catch (countErr) {
      logger.logError(`[scheduledPostExecutor] trial post count update failed id=${post.id}:`, countErr);
    }

    try {
      const schedule = await scheduleStore.getScheduleById(post.source_schedule_id);
      await sendScheduleResultEmail({ schedule, customer, post, platform, success: true, logger });
    } catch (mailErr) {
      logger.logError(`[scheduledPostExecutor] result email failed id=${post.id}:`, mailErr);
    }
  }

  const textContainsUrl = Boolean(post.contains_url) || containsUrl(post.content);
  let meterEventSent = false;
  try {
    await reportMeterEvent("post_created", customer.stripeCustomerId);
    if (platform === "x" && textContainsUrl) {
      await reportMeterEvent("x_surcharge_post", customer.stripeCustomerId);
    }
    meterEventSent = true;
  } catch (meterErr) {
    logger.logError(`[scheduledPostExecutor] meter event failed id=${post.id}:`, meterErr);
  }

  try {
    const logRecord = await createPostingLog({
      customerCode,
      createdBy: post.created_by,
      platform,
      content: post.content,
      platformPostId: postResult.id,
      containsUrl: textContainsUrl,
      meterEventSent,
      accountName: accountNameFor(platform, tokenEntry),
    });
    // 投稿一覧画面（posts.js /api/posts/list）が、この posting_log は予約投稿の実行結果であり
    // 即時投稿ではないと判定できるようにする（postingLogOriginStore.js参照。重複行防止のため）。
    postingLogOriginStore.recordScheduledOrigin(logRecord.id, post.id);
  } catch (logErr) {
    logger.logError(`[scheduledPostExecutor] posting log write failed id=${post.id}:`, logErr);
  }

  return { platform, customerCode };
}

module.exports = { attemptScheduledPost, platformKeyFromLabel };
