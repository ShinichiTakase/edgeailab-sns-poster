// 「請求情報」画面用API。確定済みStripe invoiceの一覧・PDF領収書ダウンロードを提供する。
// 一覧は全件をJSONで返し、ページネーション（50件ごと）はpost-list.htmlと同じ方針で
// フロント側で行う（Stripeのinvoices.listはカーソール式でオフセット指定ができないため、
// サーバー側でカーソルを辿って全件取得しておくほうが「Nページ目」の実装が単純になる）。
const express = require("express");
const { requireAuth, blockEditorRole } = require("../middleware/requireAuth");
const { getStripe } = require("../lib/stripeClient");
const { buildInvoiceSummary } = require("../lib/invoiceSummary");
const { generateReceiptPdf } = require("../lib/receiptPdf");

const router = express.Router();

async function listAllFinalizedInvoices(stripe, stripeCustomerId) {
  const all = [];
  let startingAfter;
  for (;;) {
    const page = await stripe.invoices.list({
      customer: stripeCustomerId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const inv of page.data) {
      // status=draft（未確定）は「請求確認を受け取った」に該当しないため除外する。
      if (inv.status === "draft") continue;
      all.push(inv);
    }
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return all;
}

router.get("/api/billing/invoices", requireAuth, blockEditorRole, async (req, res) => {
  if (!req.customer.stripeCustomerId) {
    return res.json({ invoices: [] });
  }
  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: "stripe_not_configured" });
  }

  try {
    const rawInvoices = await listAllFinalizedInvoices(stripe, req.customer.stripeCustomerId);
    const summaries = await Promise.all(
      rawInvoices.map((inv) => buildInvoiceSummary(inv, req.customer.id))
    );
    summaries.sort((a, b) => new Date(b.billedAt) - new Date(a.billedAt));
    res.json({ invoices: summaries });
  } catch (err) {
    console.error(`[invoices] list failed customerId=${req.customer.id}:`, err);
    res.status(500).json({ error: "stripe_error", message: "請求情報の取得に失敗しました。しばらくしてから再度お試しください。" });
  }
});

router.get("/api/billing/invoices/:invoiceId/receipt", requireAuth, blockEditorRole, async (req, res) => {
  if (!req.customer.stripeCustomerId) {
    return res.status(404).json({ error: "invoice_not_found" });
  }
  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: "stripe_not_configured" });
  }

  const { invoiceId } = req.params;

  try {
    const invoice = await stripe.invoices.retrieve(invoiceId);
    if (invoice.customer !== req.customer.stripeCustomerId) {
      return res.status(403).json({ error: "forbidden" });
    }
    if (invoice.status === "draft") {
      return res.status(404).json({ error: "invoice_not_found" });
    }

    const summary = await buildInvoiceSummary(invoice, req.customer.id);
    const pdfBuffer = await generateReceiptPdf(summary);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="receipt-${invoiceId}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error(`[invoices] receipt generation failed customerId=${req.customer.id} invoiceId=${invoiceId}:`, err);
    res.status(500).json({ error: "stripe_error", message: "領収書の生成に失敗しました。しばらくしてから再度お試しください。" });
  }
});

module.exports = router;
