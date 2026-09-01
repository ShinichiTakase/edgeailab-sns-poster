// SNS連携時（OAuthコールバック）の「過去に別顧客が使ったアカウントの再連携」検知と、
// それに伴うトライアル失効処理をまとめたヘルパー（2026-09-01追加、トライアル濫用防止）。
// facebook.js/instagram.js/threads.js/x.js/linkedin.jsの5ファイル全てから使う。
const customerStore = require("./customerStore");
const { isKnownTestSlug } = require("./snsConnectionModeConfig");
const { findOtherCustomerHit, recordNewIdentifiers } = require("./snsHistoryStore");

function statusOf(customer) {
  return Array.isArray(customer.status) ? customer.status[0] : customer.status;
}

// OAuthコールバックのfindDuplicateOwner通過後に呼ぶ。トライアル中（かつ検証用
// テストアカウントではない）顧客が、過去に他の顧客が連携したことのあるSNSアカウントを
// 連携しようとしている場合のみ、ヒット情報を返す（それ以外はnull＝通常通り保存へ進んでよい）。
async function checkTrialHistoryHit(platform, identifiers, slug) {
  const customer = await customerStore.getCustomerById(slug);
  if (!customer || statusOf(customer) !== "trial") return null;
  if (isKnownTestSlug(slug)) return null;
  return findOtherCustomerHit(platform, identifiers, slug);
}

// トークン保存（savePlatformTokens）の直後、同じタイミングで必ず呼ぶ。
// 記録自体はcustomer.statusを問わず行う（トライアル中に限定すると、有料顧客が
// 連携した新規アカウントが台帳に残らず、将来そのアカウントが解約等で解放された際の
// 再利用チェックが効かなくなるため）。
async function recordConnectionForHistory(platform, identifiers, slug, connectedAt) {
  recordNewIdentifiers(platform, identifiers, slug, connectedAt);
}

// 確認ダイアログで「連携」が確定し、実際にトークンが保存されるのと同じタイミングでのみ
// 呼ぶこと（保留中の確認をキャンセルされた場合に、連携していないのにトライアルだけを
// 失うバグを避けるため。詳細はsns-poster/docs/内部仕様_SNS連携.md参照）。
async function revokeTrialAfterHistoryReconnect(slug) {
  await customerStore.updateCustomer(slug, { status: ["active"], trialEndsAt: "" });
}

module.exports = { checkTrialHistoryHit, recordConnectionForHistory, revokeTrialAfterHistoryReconnect };
