// 管理者ダッシュボード「パスワード初期化」専用API。自分でパスワード再設定ができない
// ユーザー（メール未達等）向けに、運営側が新しいパスワードを直接発行してメール送信する。
// 認証はnginx側のBasic認証のみに委ねる（他のadmin系APIと同じ方針）。
const express = require("express");
const bcrypt = require("bcrypt");
const { adminSetPassword } = require("../lib/customerStore");
const { generatePassword } = require("../lib/passwordGenerator");
const { sendCustomerMail } = require("../lib/customerMailer");
const { ADMIN_PASSWORD_RESET_EMAIL } = require("../lib/emailTemplates");

const router = express.Router();

// auth.js（サインアップ・通常のパスワード再設定/変更）と同じラウンド数。
const BCRYPT_ROUNDS = 12;

router.post("/api/admin/password-reset", express.json(), async (req, res) => {
  const email = ((req.body && req.body.email) || "").trim();
  if (!email) {
    return res.status(400).json({ error: "email_required", message: "メールアドレスを入力してください" });
  }

  try {
    const newPassword = generatePassword();
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const result = await adminSetPassword(email, passwordHash);
    if (!result) {
      return res.status(404).json({ error: "user_not_found", message: "該当するユーザーが見つかりません" });
    }

    const mailResult = await sendCustomerMail({
      toEmail: result.user.email,
      subject: ADMIN_PASSWORD_RESET_EMAIL.subject,
      text: ADMIN_PASSWORD_RESET_EMAIL.body(newPassword),
    });
    // パスワード自体は既に書き換え済みのため、メール送信失敗時もエラーを分けて
    // 伝える（管理者が別の連絡手段でユーザーに伝える判断ができるように）。
    if (!mailResult.ok) {
      console.error(`[admin/password-reset] password changed but mail failed email=${email}:`, mailResult.error);
      return res.status(502).json({
        error: "mail_send_failed",
        message: "パスワードは初期化されましたが、メール送信に失敗しました。別の方法でユーザーへご連絡ください。",
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[admin/password-reset] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

module.exports = router;
