// 管理者ダッシュボード（edgeailab.net/admin/）専用API。このアプリ自体には管理者ログイン・
// セッションの概念が無いため、requireAuth等のアプリ層ミドルウェアは挟まない。
// 保護はnginx側のBasic認証のみに委ねる想定（proxy/edgeailab.net.confのlocation /api/admin/
// 参照）。このルートをBasic認証の無い経路で公開しないこと（顧客数・売上高等の非公開情報を返す）。
const express = require("express");
const { getStripe } = require("../lib/stripeClient");
const { getAdminStats } = require("../lib/adminStats");

const router = express.Router();

router.get("/api/admin/stats", async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: "stripe_not_configured" });
  }
  try {
    const stats = await getAdminStats(stripe);
    res.json(stats);
  } catch (err) {
    console.error("[admin/stats] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

module.exports = router;
