const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { ALLOWED_SCRIPTS, main } = require("./writeFreezeGuardedRunner");

const unfrozen = { existsSync: () => false };
const frozen = { existsSync: () => true };

function capture(result = { status: 0 }) {
  const calls = [];
  return {
    calls,
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return result;
    },
  };
}

test("allowlist contains exactly the production freeze-target batch scripts", () => {
  assert.deepEqual([...ALLOWED_SCRIPTS].sort(), [
    "adminStatsDailyBatch.js", "adminStatsMonthlyBatch.js", "approvalExpiryCheck.js",
    "canceledCardCleanup.js", "orphanSnsTokenCheck.js", "refreshInstagramTokens.js",
    "refreshThreadsTokens.js", "refreshXTokens.js", "scheduleAutoPauseSync.js",
    "scheduleMaterializer.js", "scheduledPostRetryRunner.js", "scheduledPostRunner.js",
    "trialPostLimitAutoActivationSync.js", "trialReminderCheck.js", "xSurchargeScheduleApply.js",
  ].sort());
});

test("argument-free script is launched directly through Node without a shell", () => {
  const child = capture();
  assert.equal(main(["scheduledPostRunner.js"], { freezeOptions: unfrozen, spawnSync: child.spawnSync }), 0);
  assert.equal(child.calls.length, 1);
  assert.equal(child.calls[0].command, process.execPath);
  assert.deepEqual(child.calls[0].args, [path.join(__dirname, "scheduledPostRunner.js")]);
  assert.equal(child.calls[0].options.shell, false);
});

test("--apply and multiple arguments preserve exact order and contents", () => {
  const child = capture();
  const supplied = ["xSurchargeScheduleApply.js", "--apply", "literal;touch /tmp/no", "$(false)"];
  assert.equal(main(supplied, { freezeOptions: unfrozen, spawnSync: child.spawnSync }), 0);
  assert.deepEqual(child.calls[0].args, [path.join(__dirname, supplied[0]), ...supplied.slice(1)]);
  assert.equal(child.calls[0].options.shell, false);
});

test("freeze blocks the child before script or arguments are processed", () => {
  const child = capture();
  assert.throws(
    () => main(["xSurchargeScheduleApply.js", "--apply"], { freezeOptions: frozen, spawnSync: child.spawnSync }),
    (error) => error && error.code === "WRITE_FREEZE_ACTIVE"
  );
  assert.equal(child.calls.length, 0);
});

test("unknown scripts, traversal, absolute paths, and --apply as script are rejected", () => {
  for (const argv of [
    ["notApproved.js"], ["../scheduledPostRunner.js"], ["/app/src/scripts/scheduledPostRunner.js"], ["--apply"], [],
  ]) {
    const child = capture();
    assert.throws(() => main(argv, { freezeOptions: unfrozen, spawnSync: child.spawnSync }), /allowed script basename/);
    assert.equal(child.calls.length, 0);
  }
});

test("child exit status propagates and signal termination maps to failure", () => {
  assert.equal(main(["scheduledPostRunner.js"], { freezeOptions: unfrozen, spawnSync: capture({ status: 23 }).spawnSync }), 23);
  assert.equal(main(["scheduledPostRunner.js"], { freezeOptions: unfrozen, spawnSync: capture({ status: null, signal: "SIGTERM" }).spawnSync }), 1);
});

test("child spawn errors propagate", () => {
  const error = Object.assign(new Error("fixture spawn error"), { code: "EACCES" });
  assert.throws(
    () => main(["scheduledPostRunner.js"], { freezeOptions: unfrozen, spawnSync: capture({ status: null, error }).spawnSync }),
    (actual) => actual === error
  );
});

test("X surcharge apply runs once, freezes without spawn, then runs once after unfreeze", () => {
  let frozenNow = false;
  const calls = [];
  const deps = {
    freezeOptions: { existsSync: () => frozenNow },
    spawnSync(command, args, options) { calls.push({ command, args, options }); return { status: 0 }; },
  };
  const command = ["xSurchargeScheduleApply.js", "--apply"];
  assert.equal(main(command, deps), 0);
  assert.equal(calls.length, 1);
  frozenNow = true;
  assert.throws(() => main(command, deps), /frozen/);
  assert.equal(calls.length, 1);
  frozenNow = false;
  assert.equal(main(command, deps), 0);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.args, [path.join(__dirname, "xSurchargeScheduleApply.js"), "--apply"]);
    assert.equal(call.options.shell, false);
  }
});
