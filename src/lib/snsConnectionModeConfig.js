// Meta系アプリ（Facebook/Instagram/Threads）がDev Modeの間、接続を許可リストの
// customer.idに限定するための単一情報源（config/snsConnectionMode.json）を読み込む。
// mode: "dev" は allowedSlugs に含まれるcustomer.idのみ接続可、"live" は無条件で可
//（Xは現時点でDev/Live区分自体が存在しないため常時 "live"）。
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "..", "config", "snsConnectionMode.json");

function loadConnectionMode() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw);
}

function isPlatformAvailable(platform, customerId) {
  const config = loadConnectionMode();
  const entry = config[platform];
  if (!entry || entry.mode === "live") return true;
  return Array.isArray(entry.allowedSlugs) && entry.allowedSlugs.includes(customerId);
}

// SNS連携履歴（snsHistoryStore.js）によるトライアル濫用防止チェックの対象外にする
// 検証用アカウント。動作確認で同じSNSアカウントを繰り返し連携し直すため、履歴ヒットの
// たびに確認ダイアログが出てしまうと検証作業に支障が出る（2026-09-01追加）。
// allowedSlugsをそのまま流用し、新たな設定ファイルは作らない。
function isKnownTestSlug(customerId) {
  const config = loadConnectionMode();
  return Object.values(config).some(
    (entry) => Array.isArray(entry.allowedSlugs) && entry.allowedSlugs.includes(customerId)
  );
}

module.exports = { loadConnectionMode, isPlatformAvailable, isKnownTestSlug };
