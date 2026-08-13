const nodemailer = require("nodemailer");

function buildTransport() {
  const port = Number(process.env.SMTP_PORT) || 587;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  });
}

async function notifyFailure(subject, text) {
  const from = process.env.SMTP_FROM;
  const to = process.env.ADDRESS_TO;
  if (!from || !to) {
    console.warn("[mailer] SMTP_FROM/ADDRESS_TO が未設定のため、通知メールをスキップします。");
    return;
  }

  try {
    const transport = buildTransport();
    await transport.sendMail({ from, to, subject, text });
  } catch (err) {
    console.error("[mailer] 通知メールの送信に失敗しました:", err);
  }
}

module.exports = { notifyFailure };
