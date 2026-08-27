// ワンショット投稿（即時投稿・予約投稿の一括登録、編集者の承認経由分を含む）の投稿結果を
// 投稿者へメール通知する。scheduleResultMailer.js（post_schedules経由のスケジュール投稿専用）
// の姉妹モジュール。オプトインは呼び出し元が判定する（即時投稿はreq.body.notifyEmail、
// 予約・承認経由分はscheduled_posts.notify_email、2026-08-27追加）。このモジュール自体は
// 送信要否を判定せず、呼ばれたら送るだけ。
// 呼び出し元: posts.js（即時投稿の同期実行分）・scheduledPostExecutor.js（予約実行・承認後の
// 実行分の成功時）・scheduledPostRetryRunner.js（再試行を打ち止めた最終失敗時）。
// 送信失敗は呼び出し元でログのみに留め、投稿処理自体の成否には影響させない方針のため、
// ここでは例外を投げずfalseを返す。
const { sendCustomerMail } = require("./customerMailer");
const { ONE_SHOT_POST_RESULT_EMAIL } = require("./emailTemplates");

const PLATFORM_DISPLAY_LABELS = { x: "X", threads: "Threads", facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn" };

/**
 * @param {object} params
 * @param {object|null} params.customer customersの1レコード（usersからメールアドレスを引く）
 * @param {string} params.recipientUserId 投稿者のuserId（即時投稿はreq.user.userId、
 *   scheduled_posts経由はpost.created_by）
 * @param {string} params.content 投稿本文
 * @param {string} params.platform "x" | "threads" | "facebook" | "instagram" | "linkedin"
 * @param {boolean} params.success 投稿結果
 * @param {{logError: Function}} [params.logger]
 */
async function sendOneShotPostResultEmail({ customer, recipientUserId, content, platform, success, logger }) {
  if (!customer) return false;

  const users = Array.isArray(customer.users) ? customer.users : [];
  const user = users.find((u) => u.userId === recipientUserId);
  const toEmail = user && user.email;
  if (!toEmail) return false;

  try {
    const result = await sendCustomerMail({
      toEmail,
      subject: ONE_SHOT_POST_RESULT_EMAIL.subject(success),
      text: ONE_SHOT_POST_RESULT_EMAIL.body(PLATFORM_DISPLAY_LABELS[platform] || platform, content, success),
    });
    return Boolean(result && result.ok);
  } catch (err) {
    if (logger) logger.logError(`[oneShotPostResultMailer] send failed recipientUserId=${recipientUserId}:`, err);
    return false;
  }
}

module.exports = { sendOneShotPostResultEmail };
