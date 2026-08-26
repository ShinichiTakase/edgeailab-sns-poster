// トライアル投稿上限（60通）到達済み顧客の自動アクティベート取りこぼしを拾う日次cron。
// 他のscripts/*.jsと同じ単発実行スクリプトで、cronから
// `docker compose run --rm sns-poster-trial-post-limit-auto-activation-sync` で
// 日次起動する想定（実際のcrontab登録は手動実施。CLAUDE.md参照）。
//
// 背景（2026-08-25）: 60通到達時の自動アクティベート（trialLimitAutoActivation.js）は、
// posts.js・scheduledPostExecutor.js・scheduleMaterializer.js・
// requireUnderTrialPostLimitミドルウェアの計4箇所いずれかが実際に動くタイミングでしか
// 発火しないリアクティブな仕組みのみだった。継続スケジュール投稿しか使っていない顧客が
// 「その日の分はscheduleMaterializer.jsで既に生成済み（last_materialized_dt一致で
// スキップ）」かつ「実行待ちのscheduled_postsが0件（実行トリガーも無い）」という状態に
// 一度でも入ると、支払い方法を登録済みでも次にその顧客の予約が新規生成されるタイミング
// （早くて翌日、曜日指定の予約なら次の該当曜日）までアクティベートされないまま放置
// される（実機で確認: shin.takase@icloud.com、2026-08-25）。このcronは上記4箇所とは
// 独立に「トライアル中かつ投稿数60通以上」の全顧客を毎日横断的にスキャンし、
// 支払い方法登録済みならアクティベートすることでこの穴を埋める。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const customerStore = require("../lib/customerStore");
const { activateAfterTrialLimitIfNeeded, sendTrialPostLimitReachedEmailIfNeeded } = require("../lib/trialLimitAutoActivation");
const { logInfo, logError } = require("../lib/logger").createLogger("trial-post-limit-auto-activation-sync.log");

async function main() {
  const candidates = await customerStore.listCustomersOverTrialPostLimit();
  logInfo(`[trial-post-limit-auto-activation-sync] ${candidates.length} candidate(s) to check`);

  let activated = 0;
  let noPaymentMethod = 0;
  let failed = 0;

  for (const customer of candidates) {
    try {
      const result = await activateAfterTrialLimitIfNeeded({ customer, logger: { logError } });
      if (result === "activated") {
        activated += 1;
        await sendTrialPostLimitReachedEmailIfNeeded({ customer, result, logger: { logError } });
        logInfo(`[trial-post-limit-auto-activation-sync] activated customerId=${customer.id}`);
      } else if (result === "no_payment_method") {
        noPaymentMethod += 1;
      } else {
        failed += 1;
        logError(`[trial-post-limit-auto-activation-sync] activation failed customerId=${customer.id}`);
      }
    } catch (err) {
      failed += 1;
      logError(`[trial-post-limit-auto-activation-sync] unexpected error customerId=${customer.id}:`, err);
    }
  }

  logInfo(
    `[trial-post-limit-auto-activation-sync] done. activated=${activated} noPaymentMethod=${noPaymentMethod} failed=${failed} candidates=${candidates.length}`
  );
}

main().catch((err) => {
  logError("[trial-post-limit-auto-activation-sync] fatal error:", err);
  process.exit(1);
});
