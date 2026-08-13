const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const customerStore = require("../lib/customerStore");
const { sendCustomerMail } = require("../lib/customerMailer");
const { INVITATION_EMAIL } = require("../lib/emailTemplates");
const { signSession, setSessionCookie } = require("../lib/jwt");
const { requireAuth } = require("../middleware/requireAuth");

const router = express.Router();

const VALID_ROLES = ["管理者", "承認者", "編集者", "閲覧者"];
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BCRYPT_ROUNDS = 12;

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// 半角英字・数字・記号をすべて含む8文字以上（signup同様の要件）
function isValidPassword(password) {
  return (
    typeof password === "string" &&
    password.length >= 8 &&
    /[A-Za-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

function buildAcceptUrl(token) {
  const base = process.env.APP_BASE_URL || "https://edgeailab.net";
  return `${base}/accept-invitation.html?token=${encodeURIComponent(token)}`;
}

function currentUserRole(user) {
  return Array.isArray(user.role) ? user.role[0] : user.role;
}

function invitationStatusOf(user) {
  return Array.isArray(user.invitationStatus) ? user.invitationStatus[0] : user.invitationStatus;
}

router.post("/api/team/invite", requireAuth, express.json(), async (req, res) => {
  if (currentUserRole(req.user) !== "管理者") {
    return res.status(403).json({ error: "forbidden" });
  }

  const { email, role } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "invalid_email" });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: "invalid_role" });
  }

  try {
    const target = email.trim().toLowerCase();
    const existing = (req.customer.users || []).find((u) => (u.email || "").toLowerCase() === target);
    if (existing) {
      return res.status(409).json({ error: "already_invited" });
    }

    const invitationToken = crypto.randomBytes(32).toString("hex");
    const invitationExpiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();

    await customerStore.addInvitedUser(req.customer.id, {
      email,
      role,
      invitedByUserId: req.user.userId,
      invitationToken,
      invitationExpiresAt,
    });

    const mailResult = await sendCustomerMail({
      toEmail: email.trim(),
      subject: INVITATION_EMAIL.subject,
      text: INVITATION_EMAIL.body(req.customer.companyName, buildAcceptUrl(invitationToken)),
    });
    if (!mailResult.ok) {
      console.warn(`[team/invite] invitation mail not sent (${mailResult.error}) for customer=${req.customer.id}`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[team/invite] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.get("/api/team/invite-info", async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).json({ error: "missing_token" });
  }

  try {
    const found = await customerStore.findCustomerAndUserByInvitationToken(token);
    if (!found) {
      return res.status(404).json({ error: "invalid_token" });
    }
    const { customer, user } = found;
    const expiresAt = user.invitationExpiresAt ? new Date(user.invitationExpiresAt).getTime() : 0;
    if (!expiresAt || expiresAt < Date.now()) {
      return res.status(410).json({ error: "expired_token" });
    }
    if (invitationStatusOf(user) === "承諾済み") {
      return res.status(409).json({ error: "already_accepted" });
    }

    res.json({
      ok: true,
      email: user.email,
      role: currentUserRole(user),
      companyName: customer.companyName || null,
    });
  } catch (err) {
    console.error("[team/invite-info] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.post("/api/team/accept-invitation", express.json(), async (req, res) => {
  const { token, password } = req.body || {};
  if (!token) {
    return res.status(400).json({ error: "missing_token" });
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({ error: "invalid_password" });
  }

  try {
    const found = await customerStore.findCustomerAndUserByInvitationToken(token);
    if (!found) {
      return res.status(404).json({ error: "invalid_token" });
    }
    const { customer, user } = found;
    const expiresAt = user.invitationExpiresAt ? new Date(user.invitationExpiresAt).getTime() : 0;
    if (!expiresAt || expiresAt < Date.now()) {
      return res.status(410).json({ error: "expired_token" });
    }
    if (invitationStatusOf(user) === "承諾済み") {
      return res.status(409).json({ error: "already_accepted" });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const updatedUser = await customerStore.acceptInvitation(customer.id, token, passwordHash);
    if (!updatedUser) {
      return res.status(404).json({ error: "invalid_token" });
    }

    const sessionToken = signSession(customer, updatedUser);
    setSessionCookie(res, sessionToken);

    res.json({ ok: true });
  } catch (err) {
    console.error("[team/accept-invitation] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

module.exports = router;
