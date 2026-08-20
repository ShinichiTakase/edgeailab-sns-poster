// 「友達に紹介」機能。ログイン中ユーザーが被紹介者を招待し、被紹介者が
// (a)サインアップ・(b)トライアル満了・(c)本稼働（支払い登録済み）に至った時点で
// 紹介者にFRIEND_COIN分のコインを付与する（実際の付与判定はcron、
// scripts/referralCoinGrantCheck.js参照）。
const express = require("express");
const crypto = require("crypto");
const customerStore = require("../lib/customerStore");
const { sendCustomerMail } = require("../lib/customerMailer");
const { REFERRAL_INVITATION_EMAIL } = require("../lib/emailTemplates");
const { requireAuth } = require("../middleware/requireAuth");

const router = express.Router();

const REFERRAL_TOKEN_TTL_MS = 10 * 24 * 60 * 60 * 1000; // 10日間

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function buildSignupUrl(token) {
  const base = process.env.APP_BASE_URL || "https://edgeailab.net";
  return `${base}/signup.html?ref=${encodeURIComponent(token)}`;
}

// ログイン中ユーザーが被紹介者を招待する。
router.post("/api/referral/invite", requireAuth, express.json(), async (req, res) => {
  const { name, email } = req.body || {};
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "invalid_name" });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "invalid_email" });
  }

  try {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + REFERRAL_TOKEN_TTL_MS).toISOString();
    await customerStore.addReferral(req.customer.id, {
      token,
      expiresAt,
      inviteeEmail: email.trim(),
    });

    const referrerName = req.customer.contactName || req.customer.email;
    const mailResult = await sendCustomerMail({
      toEmail: email.trim(),
      subject: REFERRAL_INVITATION_EMAIL.subject(referrerName),
      text: REFERRAL_INVITATION_EMAIL.body(referrerName, buildSignupUrl(token)),
    });
    if (!mailResult.ok) {
      console.warn(`[referral/invite] mail not sent (${mailResult.error}) referrerId=${req.customer.id}`);
      return res.status(502).json({ error: "mail_send_failed" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(`[referral/invite] failed referrerId=${req.customer.id}:`, err);
    res.status(500).json({ error: "internal_error" });
  }
});

// signup.html読み込み時に、紹介トークンが有効かどうかを事前確認するための参照専用API
// （password-reset-infoと同じパターン）。
router.get("/api/referral/info", async (req, res) => {
  const { token } = req.query;
  if (typeof token !== "string" || !token) {
    return res.status(400).json({ error: "missing_token" });
  }

  try {
    const found = await customerStore.findCustomerAndReferralByToken(token);
    if (!found) {
      return res.status(404).json({ error: "invalid_token" });
    }
    const expiresAt = found.referral.expiresAt ? new Date(found.referral.expiresAt).getTime() : 0;
    if (!expiresAt || expiresAt < Date.now()) {
      return res.status(410).json({ error: "expired_token" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[referral/info] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

module.exports = router;
