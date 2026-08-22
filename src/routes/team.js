const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const customerStore = require("../lib/customerStore");
const { sendCustomerMail } = require("../lib/customerMailer");
const { INVITATION_EMAIL } = require("../lib/emailTemplates");
const { signSession, setSessionCookie } = require("../lib/jwt");
const { requireAuth, requireVerified } = require("../middleware/requireAuth");

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

const { roleOf: currentUserRole, invitationStatusOf } = customerStore;

// role="編集者"の招待にはapproverIds（承認者）が最低1人必須。候補は既存のactive
// （招待承諾済み）な管理者・承認者のみに限定する（辞めたメンバーや別の編集者を
// 承認者に指定できてしまうのを防ぐ）。
function validApproverCandidateIds(customer) {
  return new Set(
    (customer.users || [])
      .filter((u) => invitationStatusOf(u) === "承諾済み" && ["管理者", "承認者"].includes(currentUserRole(u)))
      .map((u) => u.userId)
  );
}

router.post("/api/team/invite", requireAuth, requireVerified, express.json(), async (req, res) => {
  if (currentUserRole(req.user) !== "管理者") {
    return res.status(403).json({ error: "forbidden" });
  }

  const { email, name, role, approverIds } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "invalid_email" });
  }
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "invalid_name" });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: "invalid_role" });
  }
  let normalizedApproverIds = [];
  if (role === "編集者") {
    if (!Array.isArray(approverIds) || approverIds.length === 0) {
      return res.status(400).json({ error: "approver_required" });
    }
    const candidates = validApproverCandidateIds(req.customer);
    if (!approverIds.every((id) => candidates.has(id))) {
      return res.status(400).json({ error: "invalid_approver" });
    }
    normalizedApproverIds = approverIds;
  }

  try {
    const target = email.trim().toLowerCase();
    const existing = (req.customer.users || []).find((u) => (u.email || "").toLowerCase() === target);
    if (existing && invitationStatusOf(existing) === "承諾済み") {
      return res.status(409).json({ error: "already_member" });
    }

    const invitationToken = crypto.randomBytes(32).toString("hex");
    const invitationExpiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();
    const invitePayload = {
      email,
      name: name.trim(),
      role,
      approverIds: normalizedApproverIds,
      invitedByUserId: req.user.userId,
      invitationToken,
      invitationExpiresAt,
    };

    // 既存のpending中招待（同一メールアドレス）は配列に追加せず、同じ要素を
    // 新しいトークン・役割・承認者で上書きする（実質的な再招待）。
    if (existing) {
      await customerStore.reissueInvitation(req.customer.id, email, invitePayload);
    } else {
      await customerStore.addInvitedUser(req.customer.id, invitePayload);
    }

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

// メンバー一覧（team.htmlの表示・招待モーダルの承認者候補取得の両方に使う）。
// role問わず閲覧可能（承認者選択のためには編集者自身も一覧を見られる必要がある）。
router.get("/api/team/members", requireAuth, async (req, res) => {
  const members = (req.customer.users || []).map((u, index) => ({
    userId: u.userId || null,
    name: u.name || "",
    email: u.email || "",
    role: currentUserRole(u),
    status: invitationStatusOf(u),
    // users配列の先頭＝アカウント作成者（サインアップ時に作られる唯一の初期要素で、
    // 以降の招待は必ず配列末尾に追加されるため、先頭であることが保証される）。
    // 誤操作防止のため、フロント側はこのメンバーに削除ボタンを出さない。
    isOwner: index === 0,
  }));
  res.json({ members });
});

// メンバー削除。最上位の権利者（isOwner）は削除できない
// （customerStore.removeMemberで拒否される）。
router.delete("/api/team/members/:email", requireAuth, async (req, res) => {
  if (currentUserRole(req.user) !== "管理者") {
    return res.status(403).json({ error: "forbidden" });
  }

  try {
    const result = await customerStore.removeMember(req.customer.id, req.params.email);
    if (!result.ok) {
      const status = result.error === "owner_cannot_be_removed" ? 403 : 404;
      return res.status(status).json({ error: result.error });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[team/members] delete failed:", err);
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
