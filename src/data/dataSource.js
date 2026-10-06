const path = require("path");
const { openDatabase } = require("../db/connection");
const { keyringFromEnv } = require("../security/tokenCrypto");

const ALLOWED = new Set(["microcms", "sqlite"]);
let singleton;

function getDataSourceName(env = process.env) {
  const value = String(env.SNS_POSTER_DATA_SOURCE || "microcms").trim().toLowerCase();
  if (!ALLOWED.has(value)) throw new Error(`Invalid SNS_POSTER_DATA_SOURCE: ${value}`);
  return value;
}

function sqliteConfig(env = process.env) {
  const filename = env.SNS_POSTER_SQLITE_PATH;
  if (!filename) throw new Error("SNS_POSTER_SQLITE_PATH is required in sqlite mode");
  return { filename: path.resolve(filename), keyring: keyringFromEnv(env) };
}

function getSqliteContext(env = process.env) {
  if (getDataSourceName(env) !== "sqlite") throw new Error("SQLite context requested outside sqlite mode");
  if (!singleton) {
    const config = sqliteConfig(env);
    const db = openDatabase(config.filename);
    const latest = db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get();
    if (!latest || Number(latest.version) < 4) {
      db.close();
      throw new Error("SQLite schema is not migrated through change-journal coverage; automatic migration is disabled");
    }
    singleton = { db, keyring: config.keyring, filename: config.filename };
  }
  return singleton;
}

function closeSqliteContext() {
  if (singleton) singleton.db.close();
  singleton = undefined;
}

module.exports = { getDataSourceName, sqliteConfig, getSqliteContext, closeSqliteContext };
