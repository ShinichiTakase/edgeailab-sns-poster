// customerMailer.js のリグレッションテスト。
// 全顧客向けメールに共通の署名（会社名・住所・URL・問い合わせ先）が本文末尾に
// 自動付与されることを検証する。実SMTPへは接続せず、nodemailerをフェイクに
// 差し替える（billing.paymentMethods.test.jsと同じ「requireの前にexportを
// 差し替える」パターン）。
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SMTP_HOST = "smtp.example.com";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "user";
process.env.SMTP_PASSWORD = "pass";
process.env.SMTP_FROM = "noreply@edgeailab.net";

const nodemailer = require("nodemailer");

let sentMails = [];
nodemailer.createTransport = () => ({
  sendMail: async (options) => {
    sentMails.push(options);
    return { messageId: "test" };
  },
});

const { sendCustomerMail } = require("./customerMailer");

test.beforeEach(() => {
  sentMails = [];
});

test("送信本文の末尾に会社署名が付与される", async () => {
  const result = await sendCustomerMail({
    toEmail: "customer@example.com",
    subject: "テスト件名",
    text: "本文です。",
  });

  assert.equal(result.ok, true);
  assert.equal(sentMails.length, 1);
  assert.equal(sentMails[0].to, "customer@example.com");
  assert.equal(sentMails[0].subject, "テスト件名");
  assert.match(sentMails[0].text, /^本文です。/);
  assert.match(sentMails[0].text, /EdgeAI Lab - sns-posterチーム/);
  assert.match(sentMails[0].text, /〒220-0072/);
  assert.match(sentMails[0].text, /横浜市西区浅間町1丁目4番3号 ウィザードビル402/);
  assert.match(sentMails[0].text, /https:\/\/edgeailab\.net\//);
  assert.match(sentMails[0].text, /info@edgeailab\.net/);
});

test("元の本文の内容自体は変更されない（署名は末尾に追記されるのみ）", async () => {
  await sendCustomerMail({ toEmail: "customer@example.com", subject: "件名", text: "1行目\n2行目" });
  assert.ok(sentMails[0].text.startsWith("1行目\n2行目"));
});
