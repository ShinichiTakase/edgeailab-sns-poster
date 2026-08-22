// invoiceSummary.js が組み立てた構造化データから、PDF領収書を生成する。
// pdfkitの標準フォントは日本語非対応のため、Noto Sans CJK JP（単体ファイル）を同梱して使う
// （apk font-noto-cjkパッケージのttcは複数言語を1ファイルに収めたコレクション形式で、
// pdfkitが要求する単一フェイスのsfntとして読み込めないため、assets/fonts配下に
// 単体OTFを別途同梱している。@napi-rs/canvas側の動画キャプション描画（videoGenerator.js）は
// ttcのままで問題ないため、あちらは変更していない）。
const PDFDocument = require("pdfkit");
const path = require("path");
const issuer = require("./receiptIssuer");

const FONT_PATH = path.join(__dirname, "..", "..", "assets", "fonts", "NotoSansCJKjp-Regular.otf");

function formatYen(amount) {
  return `¥${Number(amount).toLocaleString("ja-JP")}`;
}

function formatDate(isoString) {
  const d = new Date(isoString);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function generateReceiptPdf(summary) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font(FONT_PATH);

    doc.fontSize(20).text("領収書", { align: "center" });
    doc.moveDown(1.5);

    doc.fontSize(10).text(`発行日: ${formatDate(summary.billedAt)}`, { align: "right" });
    doc.moveDown(1);

    // ---- 明細テーブル ----
    const rows = [];
    if (summary.baseFee.amount > 0) {
      rows.push({
        label: `基本料金${summary.planLabel ? `（${summary.planLabel}）` : ""}`,
        quantity: summary.baseFee.quantity,
        unitPrice: summary.baseFee.unitAmount,
        amount: summary.baseFee.amount,
      });
    }
    for (const line of summary.usageLines) {
      rows.push({
        label: `従量料金（${line.platform}）`,
        quantity: line.count,
        unitPrice: line.averageUnitPrice,
        amount: line.amount,
        note: summary.usageLines.length > 1 ? "平均単価" : undefined,
      });
    }
    if (summary.xSurcharge.amount > 0) {
      rows.push({
        label: "Xサーチャージ",
        quantity: summary.xSurcharge.count,
        unitPrice: summary.xSurcharge.unitPrice,
        amount: summary.xSurcharge.amount,
      });
    }
    if (summary.unclassifiedAmount > 0) {
      rows.push({ label: "その他", quantity: "-", unitPrice: "-", amount: summary.unclassifiedAmount });
    }

    const colX = { label: 50, quantity: 300, unitPrice: 370, amount: 460 };
    const tableTop = doc.y;
    doc.fontSize(10).fillColor("#444444");
    doc.text("項目", colX.label, tableTop);
    doc.text("数量", colX.quantity, tableTop);
    doc.text("単価（税別）", colX.unitPrice, tableTop);
    doc.text("金額（税別）", colX.amount, tableTop);
    doc.moveTo(50, tableTop + 16).lineTo(545, tableTop + 16).strokeColor("#cccccc").stroke();

    let y = tableTop + 24;
    doc.fillColor("#111111");
    for (const row of rows) {
      doc.fontSize(10).text(row.label, colX.label, y, { width: 240 });
      doc.text(String(row.quantity), colX.quantity, y);
      doc.text(typeof row.unitPrice === "number" ? formatYen(row.unitPrice) : row.unitPrice, colX.unitPrice, y);
      doc.text(formatYen(row.amount), colX.amount, y);
      if (row.note) {
        doc.fontSize(7).fillColor("#888888").text(`（${row.note}）`, colX.unitPrice, y + 12);
        doc.fillColor("#111111");
      }
      y += row.note ? 28 : 20;
    }

    doc.moveTo(50, y + 4).lineTo(545, y + 4).strokeColor("#cccccc").stroke();
    y += 16;

    doc.fontSize(10);
    doc.text("小計（税別）", colX.unitPrice, y);
    doc.text(formatYen(summary.subtotalExclusive), colX.amount, y);
    y += 18;
    doc.text("消費税", colX.unitPrice, y);
    doc.text(formatYen(summary.tax), colX.amount, y);
    y += 18;
    doc.fontSize(12);
    doc.text("合計", colX.unitPrice, y);
    doc.text(formatYen(summary.total), colX.amount, y);

    // ---- 発行者情報 ----
    y += 60;
    doc.fontSize(9).fillColor("#444444");
    doc.text(issuer.postalCode, 50, y);
    doc.text(issuer.address, 50, y + 14);
    doc.text(issuer.name, 50, y + 28);
    doc.text(`登録番号：${issuer.registrationNumber}`, 50, y + 42);
    doc.text(`Email：${issuer.email}`, 50, y + 56);

    doc.end();
  });
}

module.exports = { generateReceiptPdf };
