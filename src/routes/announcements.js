// 「お知らせ」一覧・既読管理API。すべてのロールが閲覧できる（blockViewerRole等の
// ロール制限は挟まない）。
const express = require("express");
const { requireAuth } = require("../middleware/requireAuth");
const { listForCustomer, markRead } = require("../lib/announcementStore");

const router = express.Router();

router.get("/api/announcements", requireAuth, (req, res) => {
  res.json({ announcements: listForCustomer(req.customer.id) });
});

// お知らせ一覧画面を開いた時点で、当該ユーザーの未読状態を解消する。
router.post("/api/announcements/read", requireAuth, express.json(), (req, res) => {
  markRead(req.user.userId);
  res.json({ ok: true });
});

module.exports = router;
