const nodemailer = require("nodemailer");

function buildTransport() {
  const port = Number(process.env.SMTP_PORT) || 25;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    // Local relay hop (postfix on the same host); STARTTLS would otherwise
    // fail certificate hostname checks against "localhost".
    ignoreTLS: port !== 465,
  });
}

async function notifyFailure(subject, text) {
  const from = process.env.ADDRESS_FROM;
  const to = process.env.ADDRESS_TO;
  if (!from || !to) {
    console.warn("[mailer] ADDRESS_FROM/ADDRESS_TO が未設定のため、通知メールをスキップします。");
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
