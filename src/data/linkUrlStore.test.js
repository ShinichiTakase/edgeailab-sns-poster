const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase } = require("../db/connection");
const { migrate, rollbackLast } = require("../db/migrationRunner");


function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "link-url-"));
  const db = openDatabase(path.join(dir, "f.sqlite3"));
  migrate(db);
  return { db, close() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("007 adds nullable link_url columns", () => {
  const f = fixture();
  try {
    for (const table of ["schedule_texts", "scheduled_posts"]) {
      const col = f.db.prepare(`PRAGMA table_info(${table})`).all().find((c) => c.name === "link_url");
      assert.ok(col, `${table}.link_url`);
      assert.equal(col.notnull, 0);
    }
  } finally { f.close(); }
});

test("007 rollback refuses to discard stored link urls", () => {
  const f = fixture();
  try {
    f.db.pragma("foreign_keys = OFF");
    f.db.prepare("INSERT INTO schedule_texts(id,schedule_id,link_url,created_at,updated_at) VALUES('t','s','https://a.example/','x','x')").run();
    assert.throws(() => rollbackLast(f.db), /CHECK/);
  } finally { f.close(); }
});
