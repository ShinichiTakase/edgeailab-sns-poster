const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const customerStore = require("../lib/customerStore");
const { sendCustomerMail } = require("../lib/customerMailer");
const { VERIFICATION_EMAIL, PASSWORD_RESET_EMAIL } = require("../lib/emailTemplates");
const { signSession, setSessionCookie, clearSessionCookie } = require("../lib/jwt");
const { requireAuth } = require("../middleware/requireAuth");
const { loadStore } = require("../lib/tokenStore");
const { getStripe } = require("../lib/stripeClient");
const { planKey } = require("../lib/stripePricing");

const router = express.Router();

const VALID_PLANS = ["basic", "standard", "advanced"];
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = 30;
const BCRYPT_ROUNDS = 12;
const RESEND_MIN_INTERVAL_MS = 60 * 1000;
const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const PASSWORD_RESET_MIN_INTERVAL_MS = 3 * 60 * 1000;

const lastResendAt = new Map();
const lastPasswordResetRequestAt = new Map();

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// 半角英字・数字・記号をすべて含む8文字以上
function isValidPassword(password) {
  return (
    typeof password === "string" &&
    password.length >= 8 &&
    /[A-Za-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

function buildVerifyUrl(token) {
  const base = process.env.APP_BASE_URL || "https://edgeailab.net";
  return `${base}/api/auth/verify?token=${encodeURIComponent(token)}`;
}

function buildResetPasswordUrl(token) {
  const base = process.env.APP_BASE_URL || "https://edgeailab.net";
  return `${base}/reset-password.html?token=${encodeURIComponent(token)}`;
}

function safeCustomer(customer) {
  return {
    email: customer.email,
    contactName: customer.contactName || null,
    plan: planKey(customer),
    isVerified: Boolean(customer.isVerified),
    trialEndsAt: customer.trialEndsAt || null,
    status: Array.isArray(customer.status) ? customer.status[0] || null : customer.status || null,
  };
}

router.post("/api/auth/check-email", express.json(), async (req, res) => {
  const { email } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "invalid_email" });
  }
  try {
    const exists = await customerStore.customerExistsByEmail(email);
    res.json({ exists });
  } catch (err) {
    console.error("[auth/check-email] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.post("/api/auth/signup", express.json(), async (req, res) => {
  const { email, password, plan, contactName, companyName } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "invalid_email" });
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({ error: "invalid_password" });
  }
  if (typeof contactName !== "string" || !contactName.trim()) {
    return res.status(400).json({ error: "invalid_contact_name" });
  }
  const normalizedPlan = VALID_PLANS.includes(plan) ? plan : "standard";

  try {
    const existing = await customerStore.getCustomerByEmail(email);
    // 解約済み（status: canceled）でなければ通常どおり重複拒否。canceledの場合のみ、
    // 新規レコードを作らずreactivateCustomerで既存レコードを再アクティブ化する
    // （解約→同一メールで再サインアップした際に無料トライアルを再取得できてしまう
    // 抜け穴を塞ぎつつ、正規の再契約は妨げないための分岐）。
    const existingStatus = existing
      ? (Array.isArray(existing.status) ? existing.status[0] : existing.status)
      : null;
    if (existing && existingStatus !== "canceled") {
      return res.status(409).json({ error: "email_exists" });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const verifyExpiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS).toISOString();
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const customerParams = {
      email,
      passwordHash,
      plan: normalizedPlan,
      contactName,
      companyName,
      verificationToken,
      verifyExpiresAt,
      trialEndsAt,
    };
    const customer = existing
      ? await customerStore.reactivateCustomer(existing.id, customerParams)
      : await customerStore.createCustomer(customerParams);

    const mailResult = await sendCustomerMail({
      toEmail: customer.email,
      subject: VERIFICATION_EMAIL.subject,
      text: VERIFICATION_EMAIL.body(buildVerifyUrl(verificationToken), normalizedPlan),
    });
    if (!mailResult.ok) {
      console.warn(`[auth/signup] verification mail not sent (${mailResult.error}) for id=${customer.id}`);
    }

    // サインアップ完了直後からダッシュボードを表示するため、
    // メール未認証のままログイン状態にする（機能制限はisVerifiedで別途ガード）。
    const signedInUser = (customer.users || []).find((u) => u.email === customer.email) || customer.users?.[0];
    const sessionToken = signSession(customer, signedInUser);
    setSessionCookie(res, sessionToken);

    res.json({ ok: true });
  } catch (err) {
    console.error("[auth/signup] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.get("/api/auth/verify", async (req, res) => {
  const { token } = req.query;
  const base = process.env.APP_BASE_URL || "https://edgeailab.net";
  if (!token) {
    return res.redirect(`${base}/verify-pending.html?error=missing_token`);
  }

  try {
    const customer = await customerStore.getCustomerByVerificationToken(token);
    if (!customer) {
      return res.redirect(`${base}/verify-pending.html?error=invalid_token`);
    }
    const expiresAt = customer.verifyExpiresAt ? new Date(customer.verifyExpiresAt).getTime() : 0;
    if (!expiresAt || expiresAt < Date.now()) {
      return res.redirect(`${base}/verify-pending.html?error=expired_token`);
    }

    await customerStore.markVerified(customer.id);

    const updated = await customerStore.getCustomerById(customer.id);
    const signedInUser = (updated.users || []).find((u) => u.email === customer.email) || updated.users?.[0];
    const sessionToken = signSession(updated, signedInUser);
    setSessionCookie(res, sessionToken);

    res.redirect(`${base}/dashboard.html`);
  } catch (err) {
    console.error("[auth/verify] failed:", err);
    res.redirect(`${base}/verify-pending.html?error=internal_error`);
  }
});

router.post("/api/auth/resend-verification", express.json(), async (req, res) => {
  const { email } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "invalid_email" });
  }

  const key = email.trim().toLowerCase();
  const last = lastResendAt.get(key) || 0;
  if (Date.now() - last < RESEND_MIN_INTERVAL_MS) {
    return res.status(429).json({ error: "too_many_requests" });
  }

  try {
    const customer = await customerStore.getCustomerByEmail(email);
    if (!customer || customer.isVerified) {
      // 存在有無を漏らさないため、未登録・認証済みいずれも同じ成功レスポンスを返す
      return res.json({ ok: true });
    }

    const verificationToken = crypto.randomBytes(32).toString("hex");
    const verifyExpiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS).toISOString();
    await customerStore.updateCustomer(customer.id, {
      verificationToken,
      verifyExpiresAt,
    });

    lastResendAt.set(key, Date.now());

    const planValue = Array.isArray(customer.plan) ? customer.plan[0] : customer.plan;
    const mailResult = await sendCustomerMail({
      toEmail: customer.email,
      subject: VERIFICATION_EMAIL.subject,
      text: VERIFICATION_EMAIL.body(buildVerifyUrl(verificationToken), planValue?.toLowerCase()),
    });
    if (!mailResult.ok) {
      console.warn(`[auth/resend-verification] mail not sent (${mailResult.error}) for id=${customer.id}`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[auth/resend-verification] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.post("/api/auth/request-password-reset", express.json(), async (req, res) => {
  const { email } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "invalid_email" });
  }

  // 登録有無を判別できないよう、対象アカウントの有無に関わらず同じキーで
  // レート制限を適用する（429の発生有無自体が列挙攻撃の手がかりにならないようにする）。
  const key = email.trim().toLowerCase();
  const last = lastPasswordResetRequestAt.get(key) || 0;
  if (Date.now() - last < PASSWORD_RESET_MIN_INTERVAL_MS) {
    return res.status(429).json({ error: "too_many_requests" });
  }
  lastPasswordResetRequestAt.set(key, Date.now());

  try {
    const found = await customerStore.findCustomerAndUserByEmail(email);
    if (found) {
      const { customer, user } = found;
      const resetToken = crypto.randomBytes(32).toString("hex");
      const resetExpiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS).toISOString();
      // 新しいトークンで上書きするため、過去に発行した未使用トークンは自動的に無効化される
      await customerStore.setPasswordResetToken(customer.id, user.userId, resetToken, resetExpiresAt);

      const mailResult = await sendCustomerMail({
        toEmail: user.email,
        subject: PASSWORD_RESET_EMAIL.subject,
        text: PASSWORD_RESET_EMAIL.body(buildResetPasswordUrl(resetToken)),
      });
      if (!mailResult.ok) {
        console.warn(
          `[auth/request-password-reset] mail not sent (${mailResult.error}) for customer=${customer.id}`
        );
      }
    }

    // 未登録のメールアドレスであっても同じ成功レスポンスを返し、登録有無を判別できないようにする
    res.json({ ok: true });
  } catch (err) {
    console.error("[auth/request-password-reset] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.get("/api/auth/password-reset-info", async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).json({ error: "missing_token" });
  }

  try {
    const found = await customerStore.findCustomerAndUserByResetToken(token);
    if (!found) {
      return res.status(404).json({ error: "invalid_token" });
    }
    const expiresAt = found.user.resetPasswordExpAt
      ? new Date(found.user.resetPasswordExpAt).getTime()
      : 0;
    if (!expiresAt || expiresAt < Date.now()) {
      return res.status(410).json({ error: "expired_token" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[auth/password-reset-info] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.post("/api/auth/reset-password", express.json(), async (req, res) => {
  const { token, password } = req.body || {};
  if (typeof token !== "string" || !token) {
    return res.status(400).json({ error: "missing_token" });
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({ error: "invalid_password" });
  }

  try {
    const found = await customerStore.findCustomerAndUserByResetToken(token);
    if (!found) {
      return res.status(404).json({ error: "invalid_token" });
    }
    const expiresAt = found.user.resetPasswordExpAt
      ? new Date(found.user.resetPasswordExpAt).getTime()
      : 0;
    if (!expiresAt || expiresAt < Date.now()) {
      return res.status(410).json({ error: "expired_token" });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    // 使用済みトークンをクリアし、sessionVersionをインクリメントして
    // 発行済みの全セッション（他デバイス・他ブラウザを含む）を無効化する
    const updatedUser = await customerStore.resetPassword(found.customer.id, token, passwordHash);
    if (!updatedUser) {
      return res.status(404).json({ error: "invalid_token" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[auth/reset-password] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.post("/api/auth/login", express.json(), async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email) || typeof password !== "string") {
    return res.status(400).json({ error: "invalid_credentials" });
  }

  try {
    // 本人（customers.email）だけでなく招待メンバー（users[].email）も
    // ログインできるよう、usersの中身まで含めて検索する。
    const found = await customerStore.findCustomerAndUserByEmail(email);
    if (!found) {
      return res.status(401).json({ error: "invalid_credentials" });
    }
    const { customer, user } = found;
    const match = await bcrypt.compare(password, user.passwordHash || "");
    if (!match) {
      return res.status(401).json({ error: "invalid_credentials" });
    }

    const sessionToken = signSession(customer, user);
    setSessionCookie(res, sessionToken);
    res.json({ ok: true, isVerified: Boolean(customer.isVerified) });
  } catch (err) {
    console.error("[auth/login] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.post("/api/auth/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ログイン中の本人によるパスワード変更。現在のパスワード検証・新パスワードの
// ポリシー適合・確認用との一致は、フロント側のチェックリスト表示を信用せず
// 必ずここでも再検証する。
router.post("/api/auth/change-password", requireAuth, express.json(), async (req, res) => {
  const { currentPassword, newPassword, newPasswordConfirm } = req.body || {};
  if (typeof currentPassword !== "string" || !currentPassword) {
    return res.status(400).json({ error: "invalid_current_password" });
  }
  if (!isValidPassword(newPassword)) {
    return res.status(400).json({ error: "invalid_password" });
  }
  if (newPassword !== newPasswordConfirm) {
    return res.status(400).json({ error: "password_mismatch" });
  }

  try {
    const match = await bcrypt.compare(currentPassword, req.user.passwordHash || "");
    if (!match) {
      return res.status(400).json({ error: "invalid_current_password" });
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    // sessionVersionのインクリメントで他デバイス・他ブラウザの既存セッションは無効化しつつ、
    // 変更を行った今回のリクエスト自身のセッションだけは新しいsessionVersionで再発行し、
    // 変更直後にログアウトさせない（設定画面からの変更なので、既存のパスワード再設定
    // フロー＝未ログイン状態からの再設定とは異なりセッション継続を優先する）。
    const updatedUser = await customerStore.changePassword(req.customer.id, req.user.userId, passwordHash);

    const sessionToken = signSession(req.customer, updatedUser);
    setSessionCookie(res, sessionToken);

    res.json({ ok: true });
  } catch (err) {
    console.error("[auth/change-password] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// customer.stripeSubscriptionIdから次回請求日（current_period_end）を読み取るだけの
// 参照専用ヘルパー。Stripe側への書き込みは一切行わない。取得できなくても
// /api/auth/me全体を失敗させず、nextBillingDateをnullにするだけに留める。
async function getNextBillingDate(customer) {
  if (!customer.stripeSubscriptionId) return null;
  const stripe = getStripe();
  if (!stripe) return null;
  try {
    const subscription = await stripe.subscriptions.retrieve(customer.stripeSubscriptionId);
    return subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null;
  } catch (err) {
    console.error("[auth/me] failed to fetch next billing date:", err);
    return null;
  }
}

router.get("/api/auth/me", requireAuth, async (req, res) => {
  const store = loadStore();
  const connected = Object.keys(store[req.customer.id] || {});
  const nextBillingDate = await getNextBillingDate(req.customer);
  res.json({
    ...safeCustomer(req.customer),
    nextBillingDate,
    connectedPlatforms: connected,
    user: {
      email: req.user.email,
      role: Array.isArray(req.user.role) ? req.user.role[0] || null : req.user.role || null,
    },
  });
});

module.exports = router;
