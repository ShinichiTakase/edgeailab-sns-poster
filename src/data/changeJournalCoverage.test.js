const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { openDatabase } = require("../db/connection");
const { migrate } = require("../db/migrationRunner");
const { COVERAGE, JOURNALED_TABLES, LEDGER_TABLES, TECHNICAL_TABLES } = require("./writeCoverageManifest");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-coverage-"));
  const db = openDatabase(path.join(dir, "fixture.sqlite3"));
  migrate(db);
  return { db, close() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("every declared SQLite write API and discovered SQL write table has one audit classification", () => {
  const apiNames = COVERAGE.map((entry) => entry.api);
  assert.equal(new Set(apiNames).size, apiNames.length, "duplicate API classification");
  assert.ok(COVERAGE.every((entry) => ["A", "B", "C"].includes(entry.category)));

  const classified = new Set([...JOURNALED_TABLES, ...LEDGER_TABLES, ...TECHNICAL_TABLES]);
  const roots = [path.join(__dirname), path.join(__dirname, "../repositories"), path.join(__dirname, "../services")];
  const files = roots.flatMap((root) => fs.readdirSync(root).filter((name) => name.endsWith(".js") && !name.endsWith(".test.js")).map((name) => path.join(root, name)));
  files.push(path.join(__dirname, "../lib/adminStats.js"));
  const discovered = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z][a-z0-9_]*)/gi)) discovered.add(match[1].toLowerCase());
  }
  assert.deepEqual([...discovered].filter((table) => table !== "set" && !classified.has(table)).sort(), []);
  for (const entry of COVERAGE) for (const table of entry.tables) assert.ok(classified.has(table), `${entry.api}: ${table}`);
});

test("all category A tables have insert/update/delete triggers", () => {
  const f = fixture();
  try {
    const triggers = new Set(f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((row) => row.name));
    for (const table of JOURNALED_TABLES) for (const operation of ["insert", "update", "delete"]) {
      assert.ok(triggers.has(`journal_${table}_${operation}`), `${table} ${operation}`);
    }
  } finally { f.close(); }
});

test("journal insert/update/delete contains transaction metadata, before/after, and rolls back atomically", () => {
  const f = fixture();
  const now = "2026-10-06T00:00:00.000Z";
  try {
    f.db.prepare("INSERT INTO customers(id,slug,primary_email,status,plan,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("c1", "slug-1", "a@example.test", "trial", "basic", now, now);
    f.db.prepare("UPDATE customers SET company_name='After',updated_at=? WHERE id='c1'").run(now);
    f.db.prepare("DELETE FROM customers WHERE id='c1'").run();
    const rows = f.db.prepare("SELECT * FROM change_journal WHERE entity_type='customers' ORDER BY occurred_at,rowid").all();
    assert.deepEqual(rows.map((row) => row.operation), ["insert", "update", "delete"]);
    for (const row of rows) {
      assert.match(row.transaction_id, /^[a-f0-9]{32}$/);
      assert.equal(row.entity_id, "c1");
      assert.ok(row.occurred_at);
    }
    assert.equal(rows[0].before_json, null);
    assert.equal(JSON.parse(rows[0].after_json).id, "c1");
    assert.equal(JSON.parse(rows[1].before_json).company_name, "");
    assert.equal(JSON.parse(rows[1].after_json).company_name, "After");
    assert.equal(JSON.parse(rows[2].before_json).id, "c1");
    assert.equal(rows[2].after_json, null);

    assert.throws(() => f.db.transaction(() => {
      f.db.prepare("INSERT INTO customers(id,slug,primary_email,status,plan,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
        .run("rollback", "rollback", "rollback@example.test", "trial", "basic", now, now);
      throw new Error("rollback fixture");
    })(), /rollback fixture/);
    assert.equal(f.db.prepare("SELECT count(*) n FROM customers WHERE id='rollback'").get().n, 0);
    assert.equal(f.db.prepare("SELECT count(*) n FROM change_journal WHERE entity_id='rollback'").get().n, 0);
  } finally { f.close(); }
});

test("password, OAuth token, secret, and ciphertext values are absent from journal payloads", () => {
  const f = fixture();
  const now = "2026-10-06T00:00:00.000Z";
  const literals = ["PLAIN_PASSWORD", "PLAIN_TOKEN", "SECRET_VALUE", "CIPHERTEXT_VALUE"];
  try {
    f.db.prepare("INSERT INTO customers(id,slug,primary_email,status,plan,verification_token_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("c1", "slug-1", "a@example.test", "trial", "basic", "SECRET_VALUE", now, now);
    f.db.prepare(`INSERT INTO users(id,customer_id,email,password_hash,role,is_owner,invitation_token_hash,reset_token_hash,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run("u1", "c1", "a@example.test", "PLAIN_PASSWORD", "管理者", 1, "PLAIN_TOKEN", "SECRET_VALUE", now, now);
    f.db.prepare(`INSERT INTO social_accounts(customer_id,platform,external_account_id,username,access_token_ciphertext,refresh_token_ciphertext,encryption_key_version,connected_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run("c1", "x", "external", "fixture", "CIPHERTEXT_VALUE", "PLAIN_TOKEN", 1, now, now);
    const serialized = f.db.prepare("SELECT before_json,after_json FROM change_journal").all().map((row) => `${row.before_json || ""}${row.after_json || ""}`).join("\n");
    for (const literal of literals) assert.equal(serialized.includes(literal), false, literal);
    for (const field of ["password_hash", "verification_token_hash", "invitation_token_hash", "reset_token_hash", "access_token_ciphertext", "refresh_token_ciphertext"]) {
      assert.equal(serialized.includes(field), false, field);
    }
  } finally { f.close(); }
});
