// スケジュール投稿（post_schedules）の notify_email がオンの場合に、投稿結果（成功/最終失敗）を
// スケジュール作成者へメール通知する。scheduledPostExecutor.js（成功時）・
// scheduledPostRetryRunner.js（再試行を打ち止めた最終失敗時）から呼ぶ。
// 送信失敗は呼び出し元でログのみに留め、投稿処理自体の成否には影響させない方針のため、
// ここでは例外を投げずfalseを返す。
const { sendCustomerMail } = require("./customerMailer");
const { SCHEDULED_POST_RESULT_EMAIL } = require("./emailTemplates");

const PLATFORM_DISPLAY_LABELS = { x: "X", threads: "Threads", facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn" };

/**
 * @param {object} params
 * @param {object|null} params.schedule post_schedulesの1レコード（notify_email/name/created_byを使う）
 * @param {object|null} params.customer customersの1レコード（usersからメールアドレスを引く）
 * @param {object} params.post scheduled_postsの1レコード（contentを使う）
 * @param {string} params.platform "x" | "threads" | "facebook" | "instagram" | "linkedin"
 * @param {boolean} params.success 投稿結果
 * @param {{logError: Function}} [params.logger]
 */
async function sendScheduleResultEmail({ schedule, customer, post, platform, success, logger }) {
  if (!schedule || !Boolean(schedule.notify_email)) return false;
  if (!customer) return false;

  const users = Array.isArray(customer.users) ? customer.users : [];
  const user = users.find((u) => u.userId === schedule.created_by);
  const toEmail = user && user.email;
  if (!toEmail) return false;

  try {
    const result = await sendCustomerMail({
      toEmail,
      subject: SCHEDULED_POST_RESULT_EMAIL.subject(success),
      text: SCHEDULED_POST_RESULT_EMAIL.body(
        schedule.name,
        PLATFORM_DISPLAY_LABELS[platform] || platform,
        post.content,
        success
      ),
    });
    return Boolean(result && result.ok);
  } catch (err) {
    if (logger) logger.logError(`[scheduleResultMailer] send failed scheduleId=${schedule.id} postId=${post.id}:`, err);
    return false;
  }
}

module.exports = { sendScheduleResultEmail };
