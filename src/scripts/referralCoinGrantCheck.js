// refreshInstagramTokens.js / trialReminderCheck.js と同じ位置づけ・構造の単発実行スクリプト。
// cronから `docker compose run --rm sns-poster-referral-coin-grant` で都度起動する想定
// （crontab登録例はCLAUDE.md参照）。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const customerStore = require("../lib/customerStore");
const { logInfo, logWarn, logError } = require("../lib/logger").createLogger("referral-coin-grant.log");

const FRIEND_COIN = Number(process.env.FRIEND_COIN) || 0;

async function main() {
  if (!FRIEND_COIN) {
    logWarn("[referral-coin-grant] FRIEND_COIN is not set (or 0); skipping run");
    return;
  }

  const candidates = await customerStore.listPendingReferralConversions();

  let succeeded = 0;
  let failed = 0;

  for (const invitee of candidates) {
    try {
      await customerStore.addCoins(invitee.referredByCustomerId, FRIEND_COIN);
      await customerStore.markReferralCoinGranted(invitee.id);
      succeeded++;
    } catch (err) {
      failed++;
      logError(
        `[referral-coin-grant] failed to grant coins referrerId=${invitee.referredByCustomerId} inviteeId=${invitee.id}:`,
        err
      );
    }
  }

  logInfo(`[referral-coin-grant] summary: succeeded=${succeeded} failed=${failed} candidates=${candidates.length}`);
}

main().catch((err) => {
  logError("[referral-coin-grant] unexpected failure:", err);
  process.exit(1);
});
