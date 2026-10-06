const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DEFAULT_DATABASE_PATH = process.env.SQLITE_DATABASE_PATH || "/app/data/sns-poster.sqlite3";

function openDatabase(filename = DEFAULT_DATABASE_PATH, options = {}) {
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new Database(filename, options);
  db.pragma("foreign_keys = ON");
  if (!options.readonly) db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("busy_timeout = 10000");
  return db;
}

module.exports = { DEFAULT_DATABASE_PATH, openDatabase };
