const path = require("path");
const { spawnSync } = require("child_process");
const { assertWritesAllowed } = require("../lib/writeFreeze");

function main(argv = process.argv.slice(2), deps = {}) {
  assertWritesAllowed(deps.freezeOptions);
  if (argv.length !== 1 || !/^[A-Za-z0-9_.-]+\.js$/.test(argv[0])) throw new Error("one script basename is required");
  const script = path.join(__dirname, argv[0]);
  const result = (deps.spawnSync || spawnSync)(process.execPath, [script], { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  return result.status == null ? 1 : result.status;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { console.error(`[write-freeze] ${error.code || "ERROR"}: ${error.message}`); process.exitCode = 75; }
}

module.exports = { main };
