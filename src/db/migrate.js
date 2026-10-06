const { openDatabase, DEFAULT_DATABASE_PATH } = require("./connection");
const { migrate, rollbackLast } = require("./migrationRunner");

function parseArgs(argv) {
  const databaseIndex = argv.indexOf("--database");
  if (databaseIndex < 0 || !argv[databaseIndex + 1]) throw new Error("--database is required");
  return { database: argv[databaseIndex + 1], rollback: argv.includes("--rollback"), allowProduction: argv.includes("--allow-production") };
}

if (require.main === module) {
  let db;
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.database === DEFAULT_DATABASE_PATH && !args.allowProduction) {
      throw new Error("refusing the configured production path without --allow-production");
    }
    db = openDatabase(args.database);
    const result = args.rollback ? rollbackLast(db) : migrate(db);
    console.log(args.rollback ? `rolled back ${result || "none"}` : `migrations applied: ${result.join(", ")}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (db) db.close();
  }
}

module.exports = { parseArgs };
