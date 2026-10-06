const fs = require("fs");
const path = require("path");
const { contentHash, sha256 } = require("./canonicalJson");
const { MICROCMS_ENDPOINTS, JSON_SOURCES } = require("./exportSources");

const PLATFORMS = new Set(["x", "threads", "facebook", "instagram", "linkedin"]);
const POST_STATES = new Set(["pending", "done", "failed"]);
const APPROVAL_STATES = new Set(["", "none", "pending", "approved", "rejected", "expired"]);

function choice(value) { return Array.isArray(value) ? value[0] || "" : value || ""; }
function validTimestamp(value) { return !value || Number.isFinite(Date.parse(value)); }
function loadExport(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  const manifestWithoutHash = { ...manifest };
  delete manifestWithoutHash.manifestHash;
  if (sha256(JSON.stringify(manifestWithoutHash)) !== manifest.manifestHash) throw new Error("manifest checksum mismatch");
  const microcms = {};
  for (const endpoint of MICROCMS_ENDPOINTS) {
    const rows = JSON.parse(fs.readFileSync(path.join(directory, manifest.microcms[endpoint].file), "utf8"));
    if (rows.length !== manifest.microcms[endpoint].count || contentHash(rows) !== manifest.microcms[endpoint].contentHash) {
      throw new Error(`microCMS export checksum mismatch: ${endpoint}`);
    }
    microcms[endpoint] = rows;
  }
  const json = {};
  for (const name of JSON_SOURCES) {
    const info = manifest.json[name];
    if (!info.present) { json[name] = null; continue; }
    const raw = fs.readFileSync(path.join(directory, info.file), "utf8");
    if (sha256(raw) !== info.contentHash) throw new Error(`JSON export checksum mismatch: ${name}`);
    json[name] = raw.trim() ? JSON.parse(raw) : null;
  }
  return { manifest, microcms, json };
}

function inspectExport(bundle) {
  const issues = [];
  const add = (severity, code, count, details = {}) => { if (count) issues.push({ severity, code, count, ...details }); };
  const { microcms: m, json: j } = bundle;
  for (const [endpoint, rows] of Object.entries(m)) {
    add("error", "duplicate_source_id", rows.length - new Set(rows.map((r) => r.id)).size, { source: endpoint });
  }
  const customerIds = new Set(m.customers.map((r) => r.id));
  const customerSlugs = new Set(m.customers.map((r) => r.slug));
  const users = m.customers.flatMap((c) => (c.users || []).map((u) => ({ ...u, customerId: c.id })));
  const userIds = users.map((u) => u.userId).filter(Boolean);
  const emails = users.map((u) => String(u.email || "").trim().toLowerCase()).filter(Boolean);
  add("error", "duplicate_user_id", userIds.length - new Set(userIds).size);
  add("error", "duplicate_user_email", emails.length - new Set(emails).size);
  add("error", "user_without_customer", users.filter((u) => !customerIds.has(u.customerId)).length);
  add("error", "user_without_id", users.filter((u) => !u.userId).length);
  add("error", "user_without_email", users.filter((u) => !u.email).length);
  const userIdSet = new Set(userIds);
  let invalidApprovers = 0;
  for (const user of users) {
    if (!user.approverIds) continue;
    let ids;
    try { ids = JSON.parse(user.approverIds); } catch { invalidApprovers += 1; continue; }
    invalidApprovers += ids.filter((id) => !userIdSet.has(id)).length;
  }
  add("error", "invalid_approver_relation", invalidApprovers);
  const scheduleIds = new Set(m.post_schedules.map((r) => r.id));
  add("error", "orphan_schedule_customer", m.post_schedules.filter((r) => !customerIds.has(r.customer_code)).length);
  add("error", "orphan_schedule_text", m.schedule_texts.filter((r) => !scheduleIds.has(r.schedule_id)).length);
  add("error", "orphan_scheduled_post_customer", m.scheduled_posts.filter((r) => !customerIds.has(r.customer_code)).length);
  add("warning", "orphan_scheduled_post_schedule", m.scheduled_posts.filter((r) => r.source_schedule_id && !scheduleIds.has(r.source_schedule_id)).length);
  add("error", "orphan_posting_log_customer", m.posting_logs.filter((r) => !customerIds.has(r.customer_code)).length);
  const createdByValues = [...m.post_schedules, ...m.schedule_texts, ...m.scheduled_posts, ...m.posting_logs]
    .map((r) => r.created_by).filter(Boolean);
  add("warning", "unresolved_created_by", createdByValues.filter((id) => !userIdSet.has(id)).length);
  const platformRows = [...m.post_schedules.flatMap((r) => r.platforms || []), ...m.scheduled_posts.map((r) => choice(r.platform)),
    ...m.posting_logs.map((r) => choice(r.platform))];
  add("error", "unknown_platform", platformRows.filter((value) => !PLATFORMS.has(value)).length);
  add("error", "unknown_post_status", m.scheduled_posts.filter((r) => !POST_STATES.has(choice(r.status))).length);
  add("error", "unknown_approval_status", [...m.schedule_texts, ...m.scheduled_posts]
    .filter((r) => !APPROVAL_STATES.has(choice(r.approval_status))).length);
  const timestampFields = ["createdAt", "updatedAt", "publishedAt", "revisedAt", "scheduled_at", "posted_at",
    "trialEndsAt", "canceledAt", "appr_requested_at", "appr_expires_at"];
  let invalidTimestamps = 0;
  for (const rows of Object.values(m)) for (const row of rows) for (const field of timestampFields) {
    if (field in row && !validTimestamp(row[field])) invalidTimestamps += 1;
  }
  add("error", "invalid_timestamp", invalidTimestamps);
  const postIds = new Set(m.scheduled_posts.map((r) => r.id));
  const logIds = new Set(m.posting_logs.map((r) => r.id));
  const origins = j["posting_log_origins.json"] || {};
  add("warning", "origin_for_missing_posting_log", Object.keys(origins).filter((id) => !logIds.has(id)).length);
  add("warning", "origin_to_missing_scheduled_post", Object.values(origins).filter((v) => !v || !postIds.has(v.scheduledPostId)).length);
  const retries = j["scheduled_post_retries.json"] || {};
  add("warning", "retry_for_missing_scheduled_post", Object.keys(retries).filter((id) => !postIds.has(id)).length);
  const tokens = j["client_tokens.json"] || {};
  const tokenOwners = Object.keys(tokens);
  add("error", "token_customer_missing", tokenOwners.filter((owner) => !customerSlugs.has(owner) && !customerIds.has(owner)).length);
  add("info", "token_owner_uses_customer_id", tokenOwners.filter((owner) => customerIds.has(owner) && !customerSlugs.has(owner)).length);
  add("info", "schema_linkedin_text_present", m.schedule_texts.filter((r) => Object.hasOwn(r, "linkedin_text")).length);
  add("info", "schema_account_name_present", m.posting_logs.filter((r) => Object.hasOwn(r, "account_name")).length);
  add("info", "schema_scheduled_post_notify_email_missing", m.scheduled_posts.filter((r) => !Object.hasOwn(r, "notify_email")).length);
  add("info", "schema_schedule_end_date_missing", m.post_schedules.filter((r) => !Object.hasOwn(r, "end_date")).length);
  return { issues, hasErrors: issues.some((issue) => issue.severity === "error") };
}

module.exports = { choice, loadExport, inspectExport };
