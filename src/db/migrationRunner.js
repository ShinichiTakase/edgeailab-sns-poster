const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { withTransaction } = require("./transaction");

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, "migrations");

function checksum(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function ensureMigrationTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

function discoverMigrations(directory = DEFAULT_MIGRATIONS_DIR) {
  return fs.readdirSync(directory)
    .filter((name) => /^\d+_.+\.sql$/.test(name) && !name.endsWith(".down.sql"))
    .sort()
    .map((name) => {
      const version = name.match(/^(\d+)_/)[1];
      const upPath = path.join(directory, name);
      const downPath = upPath.replace(/\.sql$/, ".down.sql");
      if (!fs.existsSync(downPath)) throw new Error(`rollback migration missing: ${downPath}`);
      const up = fs.readFileSync(upPath, "utf8");
      return { version, name, up, down: fs.readFileSync(downPath, "utf8"), checksum: checksum(up) };
    });
}

function migrate(db, { directory = DEFAULT_MIGRATIONS_DIR, now = () => new Date().toISOString() } = {}) {
  ensureMigrationTable(db);
  const applied = new Map(db.prepare("SELECT version, checksum FROM schema_migrations").all().map((r) => [r.version, r.checksum]));
  const migrations = discoverMigrations(directory);
  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      if (applied.get(migration.version) !== migration.checksum) throw new Error(`migration checksum mismatch: ${migration.version}`);
      continue;
    }
    withTransaction(db, () => {
      db.exec(migration.up);
      db.prepare("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.checksum, now());
    });
  }
  return migrations.map((m) => m.version);
}

function rollbackLast(db, { directory = DEFAULT_MIGRATIONS_DIR } = {}) {
  ensureMigrationTable(db);
  const last = db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get();
  if (!last) return null;
  const migration = discoverMigrations(directory).find((m) => m.version === last.version);
  if (!migration) throw new Error(`rollback migration not found: ${last.version}`);
  withTransaction(db, () => {
    db.exec(migration.down);
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(last.version);
  });
  return last.version;
}

module.exports = { DEFAULT_MIGRATIONS_DIR, checksum, discoverMigrations, ensureMigrationTable, migrate, rollbackLast };
