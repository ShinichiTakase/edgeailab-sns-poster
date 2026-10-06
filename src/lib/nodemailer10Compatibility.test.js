const assert = require("node:assert/strict");
const test = require("node:test");
const nodemailer = require("nodemailer");
const { isValidEmail } = require("./inputValidation");

test("Nodemailer 10 stream transportは既存のfrom/to/subject/text APIを維持する", async () => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  const result = await transport.sendMail({
    from: { name: "EdgeAI Lab", address: "noreply@edgeailab.net" },
    to: "customer@example.test",
    subject: "signup / password reset / invitation / notification / approval",
    text: "plain text fixture",
  });
  const message = result.message.toString("utf8");
  assert.match(message, /From: EdgeAI Lab <noreply@edgeailab\.net>/);
  assert.match(message, /To: customer@example\.test/);
  assert.match(message, /Subject:/);
  assert.match(message, /plain text fixture/);
});

test("長大本文をSMTP接続なしで処理できる", async () => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const text = "あ".repeat(200000);
  const result = await transport.sendMail({ from: "noreply@edgeailab.net", to: "customer@example.test", subject: "long", text });
  assert.ok(result.message.length > text.length);
});

test("外部入力emailは長大・改行・comment・address list・複数@を拒否する", () => {
  assert.equal(isValidEmail("normal.user+tag@example.test"), true);
  for (const value of [
    `${"a".repeat(255)}@example.test`,
    "victim@example.test\r\nBcc: attacker@example.test",
    "victim(comment)@example.test",
    "victim@example.test,attacker@example.test",
    "victim@@example.test",
    "victim@-example.test",
  ]) assert.equal(isValidEmail(value), false, value.slice(0, 80));
});
