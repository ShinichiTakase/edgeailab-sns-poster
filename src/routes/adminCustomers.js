// 管理者ダッシュボード「利用者一覧」専用API。認証はnginx側のBasic認証のみに委ねる
// （adminStats.js・announcements.js等とは異なり、アプリ層のrequireAuthは挟まない。
// proxy/edgeailab.net.confのlocation /api/admin/参照）。
const express = require("express");
const { listCustomersFiltered, getCustomerById } = require("../lib/customerStore");

const router = express.Router();

const PAGE_SIZE = 50;

function summarize(customer) {
  return {
    id: customer.id,
    email: customer.email,
    contactName: customer.contactName || "",
    companyName: customer.companyName || "",
    status: Array.isArray(customer.status) ? customer.status[0] : customer.status,
    plan: Array.isArray(customer.plan) ? customer.plan[0] : customer.plan,
    createdAt: customer.createdAt,
  };
}

router.get("/api/admin/customers", async (req, res) => {
  const email = (req.query.email || "").trim();
  const status = (req.query.status || "").trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  try {
    const { contents, totalCount } = await listCustomersFiltered({ email, status, limit: PAGE_SIZE, offset });
    res.json({
      customers: contents.map(summarize),
      page,
      pageSize: PAGE_SIZE,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / PAGE_SIZE)),
    });
  } catch (err) {
    console.error("[admin/customers] list failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

// システム制御に関わる情報（Stripe ID・パスワードハッシュ・各種トークン・
// sessionVersion等）は含めない。「どこの誰が・いつから・今のstatus・連絡方法」が
// わかれば足りるという要件のため。
router.get("/api/admin/customers/:id", async (req, res) => {
  try {
    const customer = await getCustomerById(req.params.id);
    if (!customer) return res.status(404).json({ error: "not_found" });

    res.json({
      id: customer.id,
      email: customer.email,
      contactName: customer.contactName || "",
      companyName: customer.companyName || "",
      status: Array.isArray(customer.status) ? customer.status[0] : customer.status,
      plan: Array.isArray(customer.plan) ? customer.plan[0] : customer.plan,
      createdAt: customer.createdAt,
      trialEndsAt: customer.trialEndsAt || null,
      canceledAt: customer.canceledAt || null,
      users: (customer.users || []).map((u) => ({
        email: u.email,
        name: u.name || "",
        role: Array.isArray(u.role) ? u.role[0] : u.role,
      })),
    });
  } catch (err) {
    console.error("[admin/customers] detail failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

module.exports = router;
