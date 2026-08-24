// refreshInstagramTokens.js / refreshThreadsTokens.js と同じ位置づけ・構造の単発実行スクリプト。
// cronから `docker compose run --rm sns-poster-trial-reminder-check` で
// 毎日9:00に起動する想定（crontab登録例はCLAUDE.md参照。2026-08-25に5:00→9:00へ変更）。
//
// トライアル終了（表向きの残り日数＝trialDisplayEndsAt基準）が5日前・2日前になった
// タイミングで、それぞれ1回ずつリマインドメールを送る（2026-08-25変更。それまでは
// 「残り3日以内」で1回のみだった）。加えて、トライアル中に支払い方法（Stripeカード）が
// 既に登録されている顧客にはこれらのメールを送らない（2026-08-25追加。それまでは
// customer.statusが"trial"のままなら支払い方法登録済みでも送られてしまっていた。
// billing.jsのpayment-methods/confirmはサブスクリプションを作らずcustomer.statusを
// "trial"のまま維持する設計のため、customer.status・stripeSubscriptionIdだけでは
// 判定できず、Stripe側のカード登録状況を都度確認する必要がある）。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const customerStore = require("../lib/customerStore");
const { sendCustomerMail } = require("../lib/customerMailer");
const { TRIAL_ENDING_EMAIL } = require("../lib/emailTemplates");
const { customerHasPaymentMethod } = require("../lib/trialPostLimitWarningMailer");
const { logInfo, logWarn, logError } = require("../lib/logger").createLogger("trial-reminder.log");

// 表向きの残り日数がこの日数以下になったら送る、その回だけの送信済みフラグ。
// microCMS customersスキーマへの手動フィールド追加が必要（真偽値、デフォルトfalse）。
const REMINDER_WINDOWS = [
  { displayDaysBeforeEnd: 5, sentField: "trialReminder5DaySent" },
  { displayDaysBeforeEnd: 2, sentField: "trialReminder2DaySent" },
];

async function processWindow({ displayDaysBeforeEnd, sentField }) {
  const candidates = await customerStore.listCustomersForTrialReminder(displayDaysBeforeEnd, sentField);

  let sent = 0;
  let skippedHasPaymentMethod = 0;
  let failed = 0;

  for (const customer of candidates) {
    let hasPaymentMethod = false;
    try {
      hasPaymentMethod = await customerHasPaymentMethod(customer.stripeCustomerId);
    } catch (err) {
      logWarn(`[trial-reminder] payment method check failed for id=${customer.id}, treating as none:`, err);
    }

    if (hasPaymentMethod) {
      skippedHasPaymentMethod++;
    } else {
      const base = process.env.APP_BASE_URL || "https://edgeailab.net";
      const upgradeUrl = `${base}/upgrade.html`;
      // customers.plan はセレクト項目のため ["Standard"] のような配列・先頭大文字で
      // 返ってくる。planLabel()は小文字キー（standard等）を期待するため変換する。
      const planValue = Array.isArray(customer.plan) ? customer.plan[0] : customer.plan;
      const planForLabel = typeof planValue === "string" ? planValue.toLowerCase() : planValue;

      const mailResult = await sendCustomerMail({
        toEmail: customer.email,
        subject: TRIAL_ENDING_EMAIL.subject,
        text: TRIAL_ENDING_EMAIL.body(displayDaysBeforeEnd, upgradeUrl, planForLabel),
      });

      if (!mailResult.ok) {
        failed++;
        logWarn(`[trial-reminder] mail not sent (${mailResult.error}) for id=${customer.id} window=${displayDaysBeforeEnd}日`);
        continue; // 送信できなかった回は送信済みにせず、翌日以降のcronで再試行する
      }
      sent++;
    }

    // 送信済み（または支払い方法登録済みでスキップ）のいずれも、このウィンドウは
    // 「対応済み」としてフラグを立てる。支払い方法登録済みの場合に立てないと、
    // 毎日Stripeへの問い合わせが繰り返されてしまう。
    try {
      await customerStore.updateCustomer(customer.id, { [sentField]: true });
    } catch (err) {
      failed++;
      logError(`[trial-reminder] failed to mark ${sentField} for id=${customer.id}:`, err);
    }
  }

  logInfo(
    `[trial-reminder] window=${displayDaysBeforeEnd}日前 summary: sent=${sent} skippedHasPaymentMethod=${skippedHasPaymentMethod} failed=${failed} candidates=${candidates.length}`
  );
}

async function main() {
  for (const window of REMINDER_WINDOWS) {
    await processWindow(window);
  }
}

main().catch((err) => {
  logError("[trial-reminder] unexpected failure:", err);
  process.exit(1);
});
