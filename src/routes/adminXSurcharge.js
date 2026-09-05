// 管理者ダッシュボード「Xサーチャージ」専用API。認証はnginx側のBasic認証のみに
// 委ねる（他のadmin系APIと同じ方針）。
//
// 表示する4つの値:
//   - 現在のsns-poster側Xサーチャージ（xSurchargeStore、円）
//   - Xの公式サイト等を見て管理者が手入力した参照値（ドル）
//     developer.x.comへの自動アクセスは402 Payment Requiredを返すため
//     （2026-09-05確認）、自動取得はできず手入力・保存のみ提供する
//   - 現在のドル円レート（open.er-api.com、無料・APIキー不要の為替レートAPI。
//     このAPI呼び出しのみリクエストの都度行う。他は全てローカルJSON）
//   - 上記2つから計算した実サーチャージ（円）＝表示のみ、保存はしない
//
// 「予約日付でのXサーチャージ変更」は実際のStripe課金価格を変更する本番操作
// （src/scripts/xSurchargeScheduleApply.js が予約日にcronで実行し適用する）。
// このルートは予約の保存・取得・取消のみを担当し、実際の適用ロジックは持たない。
const express = require("express");
const xSurchargeStore = require("../lib/xSurchargeStore");

const router = express.Router();

const EXCHANGE_RATE_API = "https://open.er-api.com/v6/latest/USD";

async function fetchUsdJpyRate() {
  const res = await fetch(EXCHANGE_RATE_API);
  if (!res.ok) throw new Error(`exchange rate api failed: ${res.status}`);
  const json = await res.json();
  const rate = json && json.rates && json.rates.JPY;
  if (typeof rate !== "number") throw new Error("exchange rate api: JPY rate not found");
  return rate;
}

router.get("/api/admin/x-surcharge", async (req, res) => {
  try {
    const currentAmountJpy = xSurchargeStore.getCurrentAmountJpy();
    const reference = xSurchargeStore.getXReferenceUsd();
    const reservation = xSurchargeStore.getReservation();

    let usdJpyRate = null;
    let calculatedJpy = null;
    try {
      usdJpyRate = await fetchUsdJpyRate();
      if (reference) calculatedJpy = reference.amount * usdJpyRate;
    } catch (err) {
      console.error("[admin/x-surcharge] exchange rate fetch failed:", err);
      // レート取得失敗時も他の情報は表示できるようにする（usdJpyRate/calculatedJpyはnullのまま）。
    }

    res.json({
      currentAmountJpy,
      referenceUsd: reference ? reference.amount : null,
      referenceUsdUpdatedAt: reference ? reference.updatedAt : null,
      usdJpyRate,
      calculatedJpy,
      reservation,
    });
  } catch (err) {
    console.error("[admin/x-surcharge] failed:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

router.post("/api/admin/x-surcharge/reference", express.json(), (req, res) => {
  const amount = Number(req.body && req.body.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ error: "invalid_amount", message: "有効な金額を入力してください" });
  }
  xSurchargeStore.setXReferenceUsd(amount);
  res.json({ ok: true });
});

router.post("/api/admin/x-surcharge/reserve", express.json(), (req, res) => {
  const amountJpy = Number(req.body && req.body.amountJpy);
  const effectiveDate = (req.body && req.body.effectiveDate) || "";
  if (!Number.isFinite(amountJpy) || amountJpy <= 0) {
    return res.status(400).json({ error: "invalid_amount", message: "有効な金額を入力してください" });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
    return res.status(400).json({ error: "invalid_date", message: "有効な予約日を入力してください" });
  }
  // Asia/Tokyo基準の「今日」より前の日付は予約できない（過去日での適用を防ぐ）。
  const todayJst = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  if (effectiveDate < todayJst) {
    return res.status(400).json({ error: "date_in_past", message: "予約日は今日以降の日付を指定してください" });
  }

  xSurchargeStore.setReservation({ amountJpy, effectiveDate });
  res.json({ ok: true });
});

router.delete("/api/admin/x-surcharge/reserve", (req, res) => {
  xSurchargeStore.clearReservation();
  res.json({ ok: true });
});

module.exports = router;
