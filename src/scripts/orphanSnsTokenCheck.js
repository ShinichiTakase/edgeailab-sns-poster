// SQLite-only SNS account integrity audit. Legacy JSON is migration evidence only and is
// deliberately not imported or read by this runtime job.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const { getSqliteContext } = require("../data/dataSource");
const { decryptSecret } = require("../security/tokenCrypto");
const { notifyFailure } = require("../lib/mailer");

function auditSocialAccounts({ db, keyring }) {
  const issues = [];
  const accounts = db.prepare(`SELECT sa.id,sa.customer_id,sa.platform,sa.external_account_id,
    sa.access_token_ciphertext,sa.refresh_token_ciphertext,sa.token_expires_at,sa.disconnected_at,
    c.id AS owner_id,c.status AS customer_status
    FROM social_accounts sa LEFT JOIN customers c ON c.id=sa.customer_id ORDER BY sa.id`).all();

  for (const account of accounts) {
    if (!account.owner_id) issues.push({ accountId: account.id, platform: account.platform, reason: "customer_missing" });
    if (!account.disconnected_at && account.customer_status === "canceled") {
      issues.push({ accountId: account.id, platform: account.platform, reason: "active_account_for_canceled_customer" });
    }
    if (account.token_expires_at && !Number.isFinite(Date.parse(account.token_expires_at))) {
      issues.push({ accountId: account.id, platform: account.platform, reason: "invalid_token_expiry" });
    }
    if (account.disconnected_at) continue;
    const context = `${account.platform}:${account.external_account_id}`;
    try {
      if (account.access_token_ciphertext) decryptSecret(account.access_token_ciphertext, keyring, `${context}:access`);
      if (account.refresh_token_ciphertext) decryptSecret(account.refresh_token_ciphertext, keyring, `${context}:refresh`);
    } catch {
      issues.push({ accountId: account.id, platform: account.platform, reason: "token_decryption_failed" });
    }
  }

  const duplicates = db.prepare(`SELECT platform,external_account_id,count(*) AS count
    FROM social_accounts WHERE disconnected_at IS NULL GROUP BY platform,external_account_id HAVING count(*)>1`).all();
  for (const duplicate of duplicates) {
    issues.push({ platform: duplicate.platform, reason: "duplicate_external_account", count: duplicate.count });
  }
  return { checked: accounts.length, issues };
}

async function main({ notify = !process.argv.includes("--no-notify"), logger } = {}) {
  const activeLogger = logger || require("../lib/logger").createLogger("orphan-sns-token-check.log");
  const result = auditSocialAccounts(getSqliteContext());
  if (result.issues.length > 0) {
    const lines = result.issues.map((issue) =>
      `- account_id=${issue.accountId || "n/a"} platform=${issue.platform} reason=${issue.reason}`
    );
    activeLogger.logError(`[orphan-sns-token-check] SQLite integrity issue(s)=${result.issues.length}`);
    if (notify) {
      await notifyFailure(
        "[edgeailab] SQLite SNS連携データの整合性問題を検知",
        ["SQLite social_accountsの整合性監査で問題を検知しました。", "", ...lines,
          "", "自動修正は行っていません。SQLiteの関連レコードと運用ログを確認してください。"].join("\n")
      );
    }
  }
  activeLogger.logInfo(`[orphan-sns-token-check] done. issues=${result.issues.length} checked=${result.checked}`);
  return result;
}

if (require.main === module) {
  main().catch((err) => {
    const { logError } = require("../lib/logger").createLogger("orphan-sns-token-check.log");
    logError("[orphan-sns-token-check] fatal error:", err);
    process.exit(1);
  });
}

module.exports = { auditSocialAccounts, main };
