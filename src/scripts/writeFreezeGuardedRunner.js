const path = require("path");
const { spawnSync } = require("child_process");
const { assertWritesAllowed } = require("../lib/writeFreeze");

const ALLOWED_SCRIPTS = new Set([
  "adminStatsDailyBatch.js",
  "adminStatsMonthlyBatch.js",
  "approvalExpiryCheck.js",
  "canceledCardCleanup.js",
  "orphanSnsTokenCheck.js",
  "refreshInstagramTokens.js",
  "refreshThreadsTokens.js",
  "refreshXTokens.js",
  "scheduleAutoPauseSync.js",
  "scheduleMaterializer.js",
  "scheduledPostRetryRunner.js",
  "scheduledPostRunner.js",
  "trialPostLimitAutoActivationSync.js",
  "trialReminderCheck.js",
  "xSurchargeScheduleApply.js",
]);

function main(argv = process.argv.slice(2), deps = {}) {
  assertWritesAllowed(deps.freezeOptions);
  const [scriptName, ...scriptArgs] = argv;
  if (!scriptName || !/^[A-Za-z0-9_.-]+\.js$/.test(scriptName) || !ALLOWED_SCRIPTS.has(scriptName)) {
    throw new Error("an allowed script basename is required");
  }
  if (!scriptArgs.every((arg) => typeof arg === "string")) throw new Error("script arguments must be strings");
  const script = path.join(__dirname, scriptName);
  const result = (deps.spawnSync || spawnSync)(process.execPath, [script, ...scriptArgs], {
    stdio: "inherit",
    env: process.env,
    shell: false,
  });
  if (result.error) throw result.error;
  return result.status == null ? 1 : result.status;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`[write-freeze] ${error.code || "ERROR"}: ${error.message}`); process.exitCode = 75; }
}

module.exports = { ALLOWED_SCRIPTS, main };
