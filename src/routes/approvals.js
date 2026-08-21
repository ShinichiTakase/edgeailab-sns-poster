// 承認ワークフロー（schedule_texts・scheduled_postsの投稿文章バッチ）の承認者・編集者向けAPI。
// approvalStore.jsの共通ロジックを両コレクションに対して呼び分ける薄いルート層。
const express = require("express");
const { requireAuth, readSessionToken } = require("../middleware/requireAuth");
const { verifySession } = require("../lib/jwt");
const { getCustomerById } = require("../lib/customerStore");
const approvalStore = require("../lib/approvalStore");

const router = express.Router();
const COLLECTIONS = ["schedule_texts", "scheduled_posts"];

function formatBatch(batch, { includeApprovals = true } = {}) {
  const entries =
    batch.collection === "scheduled_posts"
      ? batch.records.map((r) => ({
          id: r.id,
          platform: Array.isArray(r.platform) ? r.platform[0] : r.platform,
          content: r.content || "",
        }))
      : batch.records.map((r) => ({
          id: r.id,
          x: r.x_text || "",
          threads: r.threads_text || "",
          facebook: r.facebook_text || "",
          instagram: r.instagram_text || "",
        }));
  return {
    batchId: batch.batchId,
    collection: batch.collection,
    status: batch.status,
    requestedAt: batch.requestedAt,
    expiresAt: batch.expiresAt,
    entries,
    approvals: includeApprovals
      ? batch.approvals.map((a) => ({ approverId: a.approverId, status: a.status, respondedAt: a.respondedAt, comment: a.comment }))
      : undefined,
  };
}

// 承認者用「承認待ち一覧」。role問わず、自分がpending中の承認者として紐付いているバッチを返す
// （管理者が承認者に指定されているケースもあり得るため、roleでは絞らない）。
router.get("/api/approvals/mine", requireAuth, async (req, res) => {
  try {
    const batches = [];
    for (const collection of COLLECTIONS) {
      const found = await approvalStore.listPendingApprovalsForApprover(collection, req.user.userId);
      batches.push(...found.map((b) => formatBatch(b)));
    }
    res.json({ batches });
  } catch (err) {
    console.error("[approvals/mine] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// 編集者用「承認依頼一覧」。自分が依頼したバッチの全ステータスを返す。
router.get("/api/approvals/requests", requireAuth, async (req, res) => {
  try {
    const batches = [];
    for (const collection of COLLECTIONS) {
      const found = await approvalStore.listBatchesByCreator(collection, req.user.userId);
      batches.push(...found.map((b) => formatBatch(b)));
    }
    res.json({ batches });
  } catch (err) {
    console.error("[approvals/requests] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// メール内リンク（トークン）からのアクセス。認証不要。
router.get("/api/approvals/by-token/:token", async (req, res) => {
  try {
    let batch = null;
    let collection = null;
    for (const c of COLLECTIONS) {
      batch = await approvalStore.findBatchByToken(c, req.params.token);
      if (batch) {
        collection = c;
        break;
      }
    }
    if (!batch) {
      return res.status(404).json({ error: "invalid_token" });
    }
    if (batch.status !== "pending" || (batch.expiresAt && new Date(batch.expiresAt).getTime() < Date.now())) {
      return res.status(410).json({ error: "expired_or_decided" });
    }

    // 周辺の承認待ちバッチ一覧（同じ承認者宛の他のpending分）も合わせて返す（未ログインの
    // メールリンク経由でも他の承認待ちが見えるようにするため。schedule-detail.html 3.4参照）。
    const matchedEntry = batch.approvals.find((a) => a.token === req.params.token);
    const otherBatches = [];
    if (matchedEntry) {
      for (const c of COLLECTIONS) {
        const found = await approvalStore.listPendingApprovalsForApprover(c, matchedEntry.approverId);
        otherBatches.push(...found.filter((b) => b.batchId !== batch.batchId).map((b) => formatBatch(b, { includeApprovals: false })));
      }
    }

    res.json({ batch: formatBatch({ ...batch, collection }), otherBatches });
  } catch (err) {
    console.error("[approvals/by-token] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// ログイン中セッションがあれば復元する（存在しなくてもエラーにしない。トークンのみの
// アクセスと両立させるため、requireAuthミドルウェアではなく手動で解決する）。
async function resolveOptionalSession(req) {
  const token = readSessionToken(req);
  const payload = token && verifySession(token);
  if (!payload) return null;
  const customer = await getCustomerById(payload.sub);
  if (!customer) return null;
  const user = (customer.users || []).find((u) => u.userId === payload.userId);
  if (!user || (payload.sessionVersion || 0) !== (user.sessionVersion || 0)) return null;
  return { customer, user };
}

// 承認/却下の実行。ログインセッション（承認者本人）またはメールのトークンのどちらでも可。
router.post("/api/approvals/decide", express.json(), async (req, res) => {
  const { collection, batchId, decision, comment, token } = req.body || {};
  if (!COLLECTIONS.includes(collection)) {
    return res.status(400).json({ error: "invalid_collection" });
  }
  if (!["approved", "rejected"].includes(decision)) {
    return res.status(400).json({ error: "invalid_decision" });
  }

  try {
    const session = await resolveOptionalSession(req);
    const decideArgs = session ? { approverId: session.user.userId, decision, comment } : { token, decision, comment };
    if (!session && !token) {
      return res.status(401).json({ error: "unauthenticated" });
    }

    const result = await approvalStore.decideApproval(collection, batchId, decideArgs);
    if (result.error) {
      const statusMap = { not_found: 404, already_decided: 409, expired: 410, not_approver: 403, already_responded: 409 };
      return res.status(statusMap[result.error] || 400).json({ error: result.error });
    }

    if (result.finalStatus === "rejected") {
      const batch = await approvalStore.getBatch(collection, batchId);
      const customer = batch && (await approvalStore.resolveCustomerForBatch(collection, batch));
      if (customer && batch) {
        const summary = `承認依頼（${collection === "scheduled_posts" ? "ワンショット投稿" : "投稿文章バッチ"}）`;
        await approvalStore.sendApprovalDecidedEmail({
          customer,
          requesterUserId: batch.createdBy,
          decision: "rejected",
          summary,
          comment,
        });
      }
    }

    res.json({ ok: true, finalStatus: result.finalStatus });
  } catch (err) {
    console.error("[approvals/decide] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

module.exports = router;
