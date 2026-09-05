// 管理者ダッシュボード「投稿一覧」専用API。認証はnginx側のBasic認証のみに委ねる
// （adminCustomers.js・adminStats.js等と同じ方針）。
//
// posting_logs（成功のみ記録）と、お知らせ（announcementStore、type: "post_failure"、
// 最終的に失敗が確定した投稿のみ記録。src/lib/postFailureAnnouncer.js参照）を
// 1本のタイムラインにマージして「成功・失敗」を表現する。posting_logsは投稿失敗を
// 一切記録しないため、失敗の実データはこのお知らせストアが唯一の情報源になる
// （2026-09-05以降に発生した失敗のみ。過去分は無い）。
const express = require("express");
const { listAllPostingLogsAcrossCustomers } = require("../lib/postingLogStore");
const { listAllOfType } = require("../lib/announcementStore");
const { listAllCustomers } = require("../lib/customerStore");

const router = express.Router();

const PAGE_SIZE = 50;
const PLATFORM_DISPLAY_LABELS = { x: "X", threads: "Threads", facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn" };

function platformLabelFor(value) {
  const key = Array.isArray(value) ? value[0] : value;
  return PLATFORM_DISPLAY_LABELS[key] || key || "";
}

// customerId+userId -> メールアドレスの解決マップを作る（投稿を実行した/しようとした
// 管理者のメールアドレスを表示するため）。
function buildEmailResolver(customers) {
  const map = new Map();
  for (const customer of customers) {
    for (const user of customer.users || []) {
      map.set(`${customer.id}:${user.userId}`, user.email);
    }
  }
  return (customerId, userId) => map.get(`${customerId}:${userId}`) || "";
}

router.get("/api/admin/posts", async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  try {
    const [postingLogs, failures, customers] = await Promise.all([
      listAllPostingLogsAcrossCustomers(),
      Promise.resolve(listAllOfType("post_failure")),
      listAllCustomers(),
    ]);
    const resolveEmail = buildEmailResolver(customers);

    const successRows = postingLogs.map((log) => ({
      id: log.id,
      timestamp: log.posted_at,
      adminEmail: resolveEmail(log.customer_code, log.created_by),
      platform: platformLabelFor(log.platform),
      result: "成功",
    }));
    const failureRows = failures.map((a) => ({
      id: a.id,
      timestamp: a.createdAt,
      adminEmail: resolveEmail(a.customerCode, a.createdBy),
      platform: platformLabelFor(a.platform),
      result: "失敗",
    }));

    const merged = [...successRows, ...failureRows].sort(
      (x, y) => new Date(y.timestamp).getTime() - new Date(x.timestamp).getTime()
    );

    const totalCount = merged.length;
    const offset = (page - 1) * PAGE_SIZE;
    const pageRows = merged.slice(offset, offset + PAGE_SIZE);

    res.json({
      posts: pageRows,
      page,
      pageSize: PAGE_SIZE,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / PAGE_SIZE)),
    });
  } catch (err) {
    console.error("[admin/posts] list failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

module.exports = router;
