// 編集者が作成した投稿文章バッチ（schedule_texts）・ワンショット投稿（scheduled_posts）に対する
// 承認ワークフローの共通ロジック。
//
// microCMSは無料プランのコンテンツタイプ5個上限に既に達しているため（customerStore.js冒頭参照）、
// 承認者ごとのレコードを独立コレクション（approvals）として新設せず、対象レコード自体に
// JSON文字列で埋め込む（approvals_json）。1バッチ＝複数レコード（schedule_textsならAI一括生成のN件、
// scheduled_postsなら投稿先プラットフォーム数件）のため、承認状態（batch_id/approval_status/
// appr_requested_at/appr_expires_at/approvals_json）はバッチ内の全レコードに同一の値を
// 書き込んで揃える（非正規化。5スキーマ制約下での妥協点）。
const crypto = require("crypto");
const { microcmsFetch } = require("./microcms");
const { sendCustomerMail } = require("./customerMailer");
const { roleOf, getCustomerById } = require("./customerStore");
const scheduleStore = require("./scheduleStore");
const { APPROVAL_REQUEST_EMAIL, APPROVAL_DECIDED_EMAIL } = require("./emailTemplates");

const APPROVAL_TTL_MS = 72 * 60 * 60 * 1000;

function buildApprovalUrl(token) {
  const base = process.env.APP_BASE_URL || "https://edgeailab.net";
  return `${base}/approval.html?token=${encodeURIComponent(token)}`;
}

// 承認依頼を新規作成する対象レコードに書き込む共通フィールド（作成時にまとめて書き込む）。
function buildApprovalFields(approverIds) {
  const now = Date.now();
  const approvals = approverIds.map((approverId) => ({
    approverId,
    status: "pending",
    token: crypto.randomBytes(32).toString("hex"),
    tokenExpiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(),
    respondedAt: null,
    comment: null,
  }));
  return {
    batch_id: crypto.randomUUID(),
    approval_status: ["pending"],
    appr_requested_at: new Date(now).toISOString(),
    appr_expires_at: new Date(now + APPROVAL_TTL_MS).toISOString(),
    approvals_json: JSON.stringify(approvals),
  };
}

// 管理者作成分（承認不要）に書き込む共通フィールド。
function noneApprovalFields() {
  return {
    batch_id: "",
    approval_status: ["none"],
    appr_requested_at: "",
    appr_expires_at: "",
    approvals_json: "",
  };
}

function approvalStatusOf(record) {
  return Array.isArray(record.approval_status) ? record.approval_status[0] : record.approval_status;
}

async function listByBatchId(collection, batchId) {
  const res = await microcmsFetch(`/${collection}?filters=batch_id[equals]${encodeURIComponent(batchId)}&limit=100`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[approvalStore] listByBatchId failed ${res.status} ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  return Array.isArray(json.contents) ? json.contents : [];
}

// microCMSへの書き込みは並行数が多いと429で弾かれるため（scheduleTextStore.js/schedules.js
// 既存コメント参照）、バッチ内の全レコードを1件ずつ順番に更新する。
async function patchAll(collection, records, patch) {
  for (const r of records) {
    const res = await microcmsFetch(`/${collection}/${r.id}`, { method: "PATCH", body: JSON.stringify(patch) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[approvalStore] patchAll failed id=${r.id} ${res.status} ${text.slice(0, 300)}`);
    }
  }
}

async function getBatch(collection, batchId) {
  const records = await listByBatchId(collection, batchId);
  if (records.length === 0) return null;
  const approvals = JSON.parse(records[0].approvals_json || "[]");
  return {
    records,
    approvals,
    status: approvalStatusOf(records[0]),
    expiresAt: records[0].appr_expires_at,
    requestedAt: records[0].appr_requested_at,
  };
}

// pending中の全バッチを対象にトークンでレコードを探す（トークンはapprovals_json内の
// JSON文字列に埋め込まれておりmicroCMSのfiltersで直接検索できないため、pending中のみに
// 絞った上でJS側で走査する）。
async function findBatchByToken(collection, token) {
  const all = await listAllPages(collection, "approval_status[contains]pending");
  const seenBatchIds = new Set();
  for (const record of all) {
    if (seenBatchIds.has(record.batch_id)) continue;
    seenBatchIds.add(record.batch_id);
    const approvals = JSON.parse(record.approvals_json || "[]");
    if (approvals.some((a) => a.token === token)) {
      return getBatch(collection, record.batch_id);
    }
  }
  return null;
}

/**
 * 承認/却下を1件反映する。approverIdまたはtokenのどちらかで承認者を特定する
 * （ログイン画面からのアクセス＝approverId、メールリンク＝token）。
 * @returns {{ ok:true, finalStatus }} または {{ error: string }}
 */
async function decideApproval(collection, batchId, { approverId, token, decision, comment }) {
  const batch = await getBatch(collection, batchId);
  if (!batch) return { error: "not_found" };
  if (batch.status !== "pending") return { error: "already_decided" };
  if (batch.expiresAt && new Date(batch.expiresAt).getTime() < Date.now()) return { error: "expired" };

  const entry = approverId
    ? batch.approvals.find((a) => a.approverId === approverId)
    : batch.approvals.find((a) => a.token === token);
  if (!entry) return { error: "not_approver" };
  if (entry.status !== "pending") return { error: "already_responded" };

  entry.status = decision;
  entry.respondedAt = new Date().toISOString();
  entry.comment = comment || null;

  if (decision === "rejected") {
    await patchAll(collection, batch.records, {
      approval_status: ["rejected"],
      approvals_json: JSON.stringify(batch.approvals),
    });
    return { ok: true, finalStatus: "rejected" };
  }

  const allApproved = batch.approvals.every((a) => a.status === "approved");
  await patchAll(collection, batch.records, {
    approval_status: [allApproved ? "approved" : "pending"],
    approvals_json: JSON.stringify(batch.approvals),
  });
  return { ok: true, finalStatus: allApproved ? "approved" : "pending" };
}

// 依頼時刻+72hを過ぎてもpendingのままのバッチを失効させる。approvalExpiryCheck.js（cron）から呼ぶ。
// onExpired(batch)は各バッチが失効した直後に呼ばれる（編集者への通知メール送信用のフック。
// customer解決の方法がcollectionごとに異なるため、通知自体は呼び出し側に委ねる）。
async function checkExpiredApprovals(collection, onExpired) {
  const all = await listAllPages(collection, "approval_status[contains]pending");
  const now = Date.now();
  const seenBatchIds = new Set();
  const expiredBatchIds = [];
  for (const record of all) {
    if (seenBatchIds.has(record.batch_id)) continue;
    seenBatchIds.add(record.batch_id);
    if (record.appr_expires_at && new Date(record.appr_expires_at).getTime() < now) {
      expiredBatchIds.push(record.batch_id);
    }
  }
  for (const batchId of expiredBatchIds) {
    const batch = await getBatch(collection, batchId);
    if (!batch || batch.status !== "pending") continue;
    await patchAll(collection, batch.records, { approval_status: ["expired"] });
    if (onExpired) await onExpired(batch);
  }
  return expiredBatchIds;
}

// batch_idでグルーピングする（1バッチ＝複数レコード。scheduled_postsのプラットフォーム数件等）。
function groupByBatchId(records) {
  const groups = new Map();
  for (const r of records) {
    if (!r.batch_id) continue;
    if (!groups.has(r.batch_id)) groups.set(r.batch_id, []);
    groups.get(r.batch_id).push(r);
  }
  return Array.from(groups.entries()).map(([batchId, groupRecords]) => ({
    batchId,
    records: groupRecords,
    approvals: JSON.parse(groupRecords[0].approvals_json || "[]"),
    status: approvalStatusOf(groupRecords[0]),
    requestedAt: groupRecords[0].appr_requested_at,
    expiresAt: groupRecords[0].appr_expires_at,
    createdBy: groupRecords[0].created_by,
  }));
}

async function listAllPages(collection, filters) {
  const all = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    const res = await microcmsFetch(`/${collection}?filters=${filters}&limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`[approvalStore] listAllPages failed ${res.status} ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const contents = Array.isArray(json.contents) ? json.contents : [];
    all.push(...contents);
    if (contents.length < limit) break;
    offset += limit;
  }
  return all;
}

// 承認者用「承認待ち一覧」。自分がpending中の承認者として紐付いているバッチのみ返す。
async function listPendingApprovalsForApprover(collection, approverId) {
  const records = await listAllPages(collection, "approval_status[contains]pending");
  return groupByBatchId(records)
    .map((b) => ({ ...b, collection }))
    .filter((b) => b.approvals.some((a) => a.approverId === approverId && a.status === "pending"));
}

// 編集者用「承認依頼一覧」。自分が依頼したバッチ（承認不要=none以外）の全ステータスを返す。
async function listBatchesByCreator(collection, creatorUserId) {
  const records = await listAllPages(collection, `created_by[equals]${encodeURIComponent(creatorUserId)}`);
  return groupByBatchId(records).map((b) => ({ ...b, collection }));
}

// バッチが属する顧客を解決する。scheduled_postsはレコード自体にcustomer_codeを持つが、
// schedule_textsは持たないため、schedule_id経由でpost_schedulesのcustomer_codeを辿る。
async function resolveCustomerForBatch(collection, batch) {
  const record = batch.records[0];
  if (collection === "scheduled_posts") {
    return getCustomerById(record.customer_code);
  }
  const schedule = await scheduleStore.getScheduleById(record.schedule_id);
  if (!schedule) return null;
  return getCustomerById(schedule.customer_code);
}

// 承認依頼メールを承認者全員に送信する。approverIdsの各userIdをcustomer.usersから
// email解決する（自社の既存メンバーのみが承認者になれる制約はteam.js側で担保済み）。
async function sendApprovalRequestEmails({ customer, requesterUser, approvals, summary }) {
  for (const entry of approvals) {
    const approverUser = (customer.users || []).find((u) => u.userId === entry.approverId);
    if (!approverUser || !approverUser.email) continue;
    const mailResult = await sendCustomerMail({
      toEmail: approverUser.email,
      subject: APPROVAL_REQUEST_EMAIL.subject,
      text: APPROVAL_REQUEST_EMAIL.body(requesterUser.name || requesterUser.email, summary, buildApprovalUrl(entry.token)),
    });
    if (!mailResult.ok) {
      console.warn(`[approvalStore] approval request mail not sent (${mailResult.error}) approver=${approverUser.email}`);
    }
  }
}

// 却下・失効を編集者（依頼者）へ通知する。
async function sendApprovalDecidedEmail({ customer, requesterUserId, decision, summary, comment }) {
  const requesterUser = (customer.users || []).find((u) => u.userId === requesterUserId);
  if (!requesterUser || !requesterUser.email) return;
  const mailResult = await sendCustomerMail({
    toEmail: requesterUser.email,
    subject: APPROVAL_DECIDED_EMAIL.subject(decision),
    text: APPROVAL_DECIDED_EMAIL.body(decision, summary, comment),
  });
  if (!mailResult.ok) {
    console.warn(`[approvalStore] decision mail not sent (${mailResult.error}) requester=${requesterUser.email}`);
  }
}

module.exports = {
  APPROVAL_TTL_MS,
  buildApprovalUrl,
  buildApprovalFields,
  noneApprovalFields,
  approvalStatusOf,
  listByBatchId,
  getBatch,
  findBatchByToken,
  listPendingApprovalsForApprover,
  listBatchesByCreator,
  resolveCustomerForBatch,
  decideApproval,
  checkExpiredApprovals,
  sendApprovalRequestEmails,
  sendApprovalDecidedEmail,
};
