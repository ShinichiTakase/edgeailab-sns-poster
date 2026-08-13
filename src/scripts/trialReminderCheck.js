// refreshInstagramTokens.js / refreshThreadsTokens.js と同じ位置づけ・構造の単発実行スクリプト。
// cronから `docker compose run --rm sns-poster-trial-reminder` で都度起動する想定
// （crontab登録例はCLAUDE.md参照）。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const customerStore = require("../lib/customerStore");
const { sendCustomerMail } = require("../lib/customerMailer");
const { TRIAL_ENDING_EMAIL } = require("../lib/emailTemplates");
const { logInfo, logWarn, logError } = require("../lib/logger").createLogger("trial-reminder.log");

// トライアル残り3日以下になったタイミングで1回だけリマインドメールを送る。
const REMINDER_WINDOW_DAYS = 3;

function daysLeft(trialEndsAt) {
  const ms = new Date(trialEndsAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

async function main() {
  const candidates = await customerStore.listCustomersWithUpcomingTrialEnd(REMINDER_WINDOW_DAYS);

  let succeeded = 0;
  let failed = 0;

  for (const customer of candidates) {
    const base = process.env.APP_BASE_URL || "https://edgeailab.net";
    const upgradeUrl = `${base}/upgrade.html`;

    const mailResult = await sendCustomerMail({
      toEmail: customer.email,
      subject: TRIAL_ENDING_EMAIL.subject,
      text: TRIAL_ENDING_EMAIL.body(daysLeft(customer.trial_ends_at), upgradeUrl, customer.plan),
    });

    if (!mailResult.ok) {
      failed++;
      logWarn(`[trial-reminder] mail not sent (${mailResult.error}) for id=${customer.id}`);
      continue;
    }

    try {
      await customerStore.updateCustomer(customer.id, { trial_reminder_sent: true });
      succeeded++;
    } catch (err) {
      failed++;
      logError(`[trial-reminder] failed to mark reminder sent for id=${customer.id}:`, err);
    }
  }

  logInfo(`[trial-reminder] summary: succeeded=${succeeded} failed=${failed} candidates=${candidates.length}`);
}

main().catch((err) => {
  logError("[trial-reminder] unexpected failure:", err);
  process.exit(1);
});
