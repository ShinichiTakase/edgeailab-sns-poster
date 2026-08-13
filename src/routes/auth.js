const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const customerStore = require("../lib/customerStore");
const { sendCustomerMail } = require("../lib/customerMailer");
const { VERIFICATION_EMAIL } = require("../lib/emailTemplates");
const { signSession, setSessionCookie, clearSessionCookie } = require("../lib/jwt");
const { requireAuth } = require("../middleware/requireAuth");
const { loadStore } = require("../lib/tokenStore");

const router = express.Router();

const VALID_PLANS = ["basic", "standard", "advanced"];
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = 30;
const BCRYPT_ROUNDS = 12;
const RESEND_MIN_INTERVAL_MS = 60 * 1000;

const lastResendAt = new Map();

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function buildVerifyUrl(token) {
  const base = process.env.APP_BASE_URL || "https://edgeailab.net";
  return `${base}/api/auth/verify?token=${encodeURIComponent(token)}`;
}

function safeCustomer(customer) {
  return {
    email: customer.email,
    plan: customer.plan,
    isVerified: Boolean(customer.is_verified),
    trialEndsAt: customer.trial_ends_at || null,
    stripeSubscriptionStatus: customer.stripe_subscription_status || null,
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
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "invalid_password" });
  }
  if (typeof contactName !== "string" || !contactName.trim()) {
    return res.status(400).json({ error: "invalid_contact_name" });
  }
  const normalizedPlan = VALID_PLANS.includes(plan) ? plan : "standard";

  try {
    const existing = await customerStore.getCustomerByEmail(email);
    if (existing) {
      return res.status(409).json({ error: "email_exists" });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const customer = await customerStore.createCustomer({
      email,
      passwordHash,
      plan: normalizedPlan,
      contactName,
      companyName,
    });

    // TODO: customers スキーマに verification_token 等の項目がないため、
    // このリンクは現状クリックしても認証できない（別途方式を要決定）。
    const verificationToken = crypto.randomBytes(32).toString("hex");

    const mailResult = await sendCustomerMail({
      toEmail: customer.email,
      subject: VERIFICATION_EMAIL.subject,
      text: VERIFICATION_EMAIL.body(buildVerifyUrl(verificationToken), normalizedPlan),
    });
    if (!mailResult.ok) {
      console.warn(`[auth/signup] verification mail not sent (${mailResult.error}) for id=${customer.id}`);
    }

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
    const expiresAt = customer.verification_token_expires_at
      ? new Date(customer.verification_token_expires_at).getTime()
      : 0;
    if (!expiresAt || expiresAt < Date.now()) {
      return res.redirect(`${base}/verify-pending.html?error=expired_token`);
    }

    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await customerStore.markVerified(customer.id, trialEndsAt);

    const updated = await customerStore.getCustomerById(customer.id);
    const sessionToken = signSession(updated);
    setSessionCookie(res, sessionToken);

    res.redirect(`${base}/onboarding.html`);
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
    if (!customer || customer.is_verified) {
      // 存在有無を漏らさないため、未登録・認証済みいずれも同じ成功レスポンスを返す
      return res.json({ ok: true });
    }

    const verificationToken = crypto.randomBytes(32).toString("hex");
    const verificationTokenExpiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS).toISOString();
    await customerStore.updateCustomer(customer.id, {
      verification_token: verificationToken,
      verification_token_expires_at: verificationTokenExpiresAt,
    });

    lastResendAt.set(key, Date.now());

    const mailResult = await sendCustomerMail({
      toEmail: customer.email,
      subject: VERIFICATION_EMAIL.subject,
      text: VERIFICATION_EMAIL.body(buildVerifyUrl(verificationToken), customer.plan),
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

router.post("/api/auth/login", express.json(), async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email) || typeof password !== "string") {
    return res.status(400).json({ error: "invalid_credentials" });
  }

  try {
    const customer = await customerStore.getCustomerByEmail(email);
    if (!customer) {
      return res.status(401).json({ error: "invalid_credentials" });
    }
    const passwordHash = customer.users?.[0]?.password_hash || "";
    const match = await bcrypt.compare(password, passwordHash);
    if (!match) {
      return res.status(401).json({ error: "invalid_credentials" });
    }

    const sessionToken = signSession(customer);
    setSessionCookie(res, sessionToken);
    res.json({ ok: true, isVerified: Boolean(customer.is_verified) });
  } catch (err) {
    console.error("[auth/login] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.post("/api/auth/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get("/api/auth/me", requireAuth, (req, res) => {
  const store = loadStore();
  const connected = Object.keys(store[req.customer.id] || {});
  res.json({ ...safeCustomer(req.customer), connectedPlatforms: connected });
});

module.exports = router;
