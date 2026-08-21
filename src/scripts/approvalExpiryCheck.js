// 承認依頼の期限切れチェック。依頼時刻+72hを過ぎてもpendingのままの投稿文章バッチ
// （schedule_texts）・ワンショット投稿（scheduled_posts）を"expired"にし、依頼者（編集者）へ
// メール通知する。cronから `docker compose run --rm sns-poster-approval-expiry-check` で
// 15〜30分おきに起動する想定（実際のcrontab登録は手動実施。CLAUDE.md参照）。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const approvalStore = require("../lib/approvalStore");
const { logInfo, logError } = require("../lib/logger").createLogger("approval-expiry-check.log");

const COLLECTIONS = ["schedule_texts", "scheduled_posts"];

async function notifyExpired(collection, batch) {
  try {
    const customer = await approvalStore.resolveCustomerForBatch(collection, batch);
    if (!customer) return;
    const summary = `承認依頼（${collection === "scheduled_posts" ? "ワンショット投稿" : "投稿文章バッチ"}）`;
    await approvalStore.sendApprovalDecidedEmail({
      customer,
      requesterUserId: batch.createdBy,
      decision: "expired",
      summary,
    });
  } catch (err) {
    logError(`[approval-expiry-check] notify failed collection=${collection} batchId=${batch.batchId}:`, err);
  }
}

async function main() {
  let totalExpired = 0;
  for (const collection of COLLECTIONS) {
    const expiredBatchIds = await approvalStore.checkExpiredApprovals(collection, (batch) => notifyExpired(collection, batch));
    totalExpired += expiredBatchIds.length;
    if (expiredBatchIds.length > 0) {
      logInfo(`[approval-expiry-check] collection=${collection} expired=${expiredBatchIds.length} batchIds=${expiredBatchIds.join(",")}`);
    }
  }
  logInfo(`[approval-expiry-check] done. totalExpired=${totalExpired}`);
}

main().catch((err) => {
  logError("[approval-expiry-check] fatal error:", err);
  process.exit(1);
});
