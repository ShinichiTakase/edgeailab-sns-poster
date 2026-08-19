// 予約投稿の実行エンジン。他のscripts/*.jsと同じ位置づけ・構造の単発実行スクリプトで、
// cronから `docker compose run --rm sns-poster-scheduled-post-runner` で定期起動する想定
// （実際のcrontab登録は手動実施。CLAUDE.md参照）。
//
// scheduled_postsのうち、以下すべてを満たすものを実際にSNSへ投稿する:
//   - status = pending
//   - scheduled_at が現在時刻を過ぎている（実行すべきタイミングに達している）
//   - scheduled_at が SCOPE_CUTOFF_AT より後（このエンジン導入前に作られた予約は、
//     実際に実行される前提なしに作られたものが混在しうるため対象外とする）
//   - created_by が "test"（手動テスト投稿）ではない
// 成功: status="done"に更新し、即時投稿と同じくposting_logsへ記録・Stripeメーターイベント
//       送信も行う（実行エンジンが存在しなかったため今まで免れていたが、実際に投稿される
//       以上は即時投稿と同じ課金対象にするのが一貫している）。完了時刻はmicroCMSの
//       updatedAt（status更新時刻）をそのまま使う。posted_atのような専用フィールドは
//       スキーマに存在しないため追加していない。
// 失敗: status="failed"に更新するのみ（課金なし）。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { listDuePendingScheduledPosts, markScheduledPostStatus, PLATFORM_LABELS } = require("../lib/scheduledPostStore");
const { createPostingLog } = require("../lib/postingLogStore");
const { loadStore } = require("../lib/tokenStore");
const { getCustomerById, isTrialPostLimitReached, isCanceled } = require("../lib/customerStore");
const { reportMeterEvent } = require("../lib/meterEvents");
const { containsUrl } = require("../lib/urlDetection");
const xPoster = require("../lib/xPoster");
const facebookPoster = require("../lib/facebookPoster");
const instagramPoster = require("../lib/instagramPoster");
const threadsPoster = require("../lib/threadsPoster");
const { logInfo, logWarn, logError } = require("../lib/logger").createLogger("scheduled-post-runner.log");

// このエンジンをデプロイした時刻（固定値）。過去にこの時刻より前のscheduled_atを持つ
// pending予約は、今後もこのエンジンの対象にはしない（変更しないこと。書き換えると
// 積み残っていた過去予約が一斉に実行されてしまう）。
const SCOPE_CUTOFF_AT = "2026-08-17T22:44:38.000Z";

// posts.jsのpostToPlatformと同じ方針：imageUrl/videoUrlはInstagramにのみ渡す
// （Facebook/Threadsに渡すと写真投稿扱いになりog:imageリンクプレビューが出なくなるため）。
// Instagramはvideo_urlがあればリール投稿、なければ従来通り画像投稿にフォールバックする。
async function postToPlatform(platform, entry, text, imageUrl, videoUrl, facebookPageId) {
  if (platform === "x") {
    return xPoster.postText(entry.access_token, text);
  }
  if (platform === "threads") {
    return threadsPoster.postText({ userId: entry.user_id, accessToken: entry.access_token }, text);
  }
  if (platform === "facebook") {
    const pages = entry.pages || [];
    // facebookPageIdが指定されていればそのページへ、未指定（旧データ・単一ページ運用等）
    // なら先頭ページへフォールバックする。
    const page = facebookPageId ? pages.find((p) => p.pageId === facebookPageId) : pages[0];
    if (!page) throw new Error("facebook_page_not_found");
    return facebookPoster.postText({ pageId: page.pageId, pageAccessToken: page.pageAccessToken }, text);
  }
  if (platform === "instagram") {
    const igEntry = { igUserId: entry.user_id, accessToken: entry.access_token };
    if (videoUrl) return instagramPoster.postReel(igEntry, text, videoUrl);
    return instagramPoster.postImage(igEntry, text, imageUrl);
  }
  throw new Error(`unknown_platform:${platform}`);
}

function platformKeyFromLabel(value) {
  const label = Array.isArray(value) ? value[0] : value;
  return Object.keys(PLATFORM_LABELS).find((k) => PLATFORM_LABELS[k] === label) || null;
}

async function main() {
  const duePosts = await listDuePendingScheduledPosts(SCOPE_CUTOFF_AT);
  if (duePosts.length === 0) {
    logInfo("[scheduled-post-runner] no due posts");
    return;
  }
  logInfo(`[scheduled-post-runner] ${duePosts.length} due post(s) found`);

  const customerCache = new Map();
  async function getCustomerCached(customerCode) {
    if (!customerCache.has(customerCode)) {
      customerCache.set(customerCode, await getCustomerById(customerCode));
    }
    return customerCache.get(customerCode);
  }

  let succeeded = 0;
  let failed = 0;

  for (const post of duePosts) {
    const platform = platformKeyFromLabel(post.platform);
    const customerCode = post.customer_code;

    try {
      if (!platform) throw new Error(`invalid_platform_value:${JSON.stringify(post.platform)}`);

      const customer = await getCustomerCached(customerCode);
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
        post.facebook_page_id || null
      );

      await markScheduledPostStatus(post.id, "done");

      const textContainsUrl = Boolean(post.contains_url) || containsUrl(post.content);
      let meterEventSent = false;
      try {
        await reportMeterEvent("post_created", customer.stripeCustomerId);
        if (platform === "x" && textContainsUrl) {
          await reportMeterEvent("x_surcharge_post", customer.stripeCustomerId);
        }
        meterEventSent = true;
      } catch (meterErr) {
        logError(`[scheduled-post-runner] meter event failed id=${post.id}:`, meterErr);
      }

      try {
        await createPostingLog({
          customerCode,
          createdBy: post.created_by,
          platform,
          content: post.content,
          platformPostId: postResult.id,
          containsUrl: textContainsUrl,
          meterEventSent,
        });
      } catch (logErr) {
        logError(`[scheduled-post-runner] posting log write failed id=${post.id}:`, logErr);
      }

      succeeded += 1;
      logInfo(`[scheduled-post-runner] posted id=${post.id} platform=${platform} customerCode=${customerCode}`);
    } catch (err) {
      failed += 1;
      logError(`[scheduled-post-runner] failed id=${post.id} platform=${platform} customerCode=${customerCode}:`, err);
      try {
        await markScheduledPostStatus(post.id, "failed");
      } catch (markErr) {
        logError(`[scheduled-post-runner] failed to mark status=failed id=${post.id}:`, markErr);
      }
    }
  }

  logInfo(`[scheduled-post-runner] done. succeeded=${succeeded} failed=${failed}`);
}

main().catch((err) => {
  logError("[scheduled-post-runner] fatal error:", err);
  process.exit(1);
});
