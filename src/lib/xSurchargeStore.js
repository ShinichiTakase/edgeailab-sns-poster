// Xサーチャージの「現在値」（金額・実際に使うStripe Price ID）と「予約中の変更」を
// JSONファイルで管理する。config/surcharge.json（Dockerイメージにビルド時COPYされる、
// 実行時には書き換えられない）とは異なり、json/配下（docker-compose.ymlでbind mount済み、
// コンテナ再作成後も残る）に置く。
//
// 現在値が未設定（バッチが一度も走っていない・導入直後）の間は、
// config/surcharge.json（surchargeConfig.js）とSTRIPE_PRICE_*_METERED_X環境変数を
// そのまま使う（＝2026-09-05以前と同じ挙動）。xSurchargeScheduleApply.js
//（cron、予約日到達時に実行）が初めて適用を行った時点でこのファイルが作られ、
// 以降はこちらが実際に使われる値の唯一の情報源になる。
const fs = require("fs");
const path = require("path");
const { getXSurcharge } = require("./surchargeConfig");

const CURRENT_PATH = path.join(__dirname, "..", "..", "json", "x_surcharge_current.json");
const RESERVATION_PATH = path.join(__dirname, "..", "..", "json", "x_surcharge_reservation.json");

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/** 現在のXサーチャージ額（円）。バッチ適用済みならその値、まだなら初期configの値。 */
function getCurrentAmountJpy() {
  const current = readJson(CURRENT_PATH);
  if (current && typeof current.amountJpy === "number") return current.amountJpy;
  return getXSurcharge().amount_jpy;
}

/** 指定プランの実際のmeteredX Price ID。バッチ適用済みならその値、まだなら未定義
 * （呼び出し側でSTRIPE_PRICE_*_METERED_X環境変数にフォールバックする）。 */
function getCurrentPriceId(plan) {
  const current = readJson(CURRENT_PATH);
  return (current && current.priceIds && current.priceIds[plan]) || null;
}

/** バッチ適用後に呼ぶ。以降getCurrentAmountJpy/getCurrentPriceIdがこの値を返す。 */
function setCurrent({ amountJpy, priceIds }) {
  writeJson(CURRENT_PATH, { amountJpy, priceIds, updatedAt: new Date().toISOString() });
}

/** Xの公式サイト等を見て管理者が手入力する参照値（ドル）。自動取得はできないため
 * （developer.x.comは自動アクセスに402を返す。2026-09-05確認）、値・確認日時ともに
 * 管理者の入力に委ねる。 */
function getXReferenceUsd() {
  const current = readJson(CURRENT_PATH);
  if (!current || typeof current.referenceUsd !== "number") return null;
  return { amount: current.referenceUsd, updatedAt: current.referenceUsdUpdatedAt || null };
}

function setXReferenceUsd(amount) {
  const current = readJson(CURRENT_PATH) || {};
  writeJson(CURRENT_PATH, { ...current, referenceUsd: amount, referenceUsdUpdatedAt: new Date().toISOString() });
}

/** 予約中のXサーチャージ変更（無ければnull）。1件のみ保持（新規予約は上書きする）。 */
function getReservation() {
  return readJson(RESERVATION_PATH);
}

function setReservation({ amountJpy, effectiveDate }) {
  writeJson(RESERVATION_PATH, { amountJpy, effectiveDate, createdAt: new Date().toISOString(), appliedAt: null });
}

function clearReservation() {
  if (fs.existsSync(RESERVATION_PATH)) fs.unlinkSync(RESERVATION_PATH);
}

module.exports = {
  getCurrentAmountJpy,
  getCurrentPriceId,
  setCurrent,
  getXReferenceUsd,
  setXReferenceUsd,
  getReservation,
  setReservation,
  clearReservation,
};
