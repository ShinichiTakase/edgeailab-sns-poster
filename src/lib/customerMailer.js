// 顧客向けメール（認証メール・トライアル終了リマインド）の送信。
// 既存 src/lib/mailer.js（障害通知専用）と同じ、認証付きmail.edgeailab.net中継
// （SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD）を使う。
const nodemailer = require("nodemailer");

function getMailFrom() {
  const address = process.env.SMTP_FROM;
  const name = process.env.MAIL_FROM_NAME || "EdgeAI Lab";
  return { name, address };
}

function buildTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

/**
 * @param {{toEmail: string, subject: string, text: string}} input
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
async function sendCustomerMail({ toEmail, subject, text }) {
  const fromAddr = process.env.SMTP_FROM;
  if (!fromAddr) {
    console.warn("[customerMailer] SMTP_FROM が未設定のため送信をスキップします。");
    return { ok: false, error: "mail_from_not_configured" };
  }
  const transport = buildTransport();
  if (!transport) {
    console.warn("[customerMailer] SMTP_HOST/SMTP_USER/SMTP_PASSWORD が未設定のため送信をスキップします。");
    return { ok: false, error: "smtp_not_configured" };
  }
  try {
    await transport.sendMail({ from: getMailFrom(), to: toEmail, subject, text });
    return { ok: true };
  } catch (err) {
    console.error("[customerMailer] 送信に失敗しました:", err);
    return { ok: false, error: "send_failed" };
  }
}

module.exports = { sendCustomerMail };
