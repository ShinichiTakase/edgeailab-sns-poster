const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase } = require("./db/connection");
const { migrate } = require("./db/migrationRunner");
const { encryptSecret } = require("./security/tokenCrypto");
const { auditSocialAccounts } = require("./scripts/orphanSnsTokenCheck");

const keyring = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 9)]]) };
const now = "2026-10-07T00:00:00.000Z";
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase5-"));
  const file = path.join(dir, "db.sqlite3");
  const db = openDatabase(file); migrate(db);
  db.prepare("INSERT INTO customers(id,slug,primary_email,status,plan,created_at,updated_at)VALUES('c1','slug','a@example.test','active','basic',?,?)").run(now,now);
  return { dir, file, db, close() { db.close(); fs.rmSync(dir,{recursive:true,force:true}); } };
}

test("SQLite social account audit ignores legacy JSON and accepts a valid relation", () => {
  const f=fixture();
  try {
    const context="x:external-1";
    f.db.prepare(`INSERT INTO social_accounts(customer_id,platform,external_account_id,access_token_ciphertext,
      refresh_token_ciphertext,encryption_key_version,token_expires_at,connected_at,updated_at)
      VALUES('c1','x','external-1',?,?,?,?,?,?)`).run(
      encryptSecret("access",keyring,`${context}:access`),encryptSecret("refresh",keyring,`${context}:refresh`),1,
      "2026-12-01T00:00:00.000Z",now,now);
    const legacy=path.join(f.dir,"client_tokens.json");
    fs.writeFileSync(legacy,JSON.stringify({legacy_orphan:{x:{access_token:"plaintext"}}}));
    assert.deepEqual(auditSocialAccounts({db:f.db,keyring}),{checked:1,issues:[]});
    assert.equal(fs.readFileSync(legacy,"utf8").includes("legacy_orphan"),true);
  } finally { f.close(); }
});

test("SQLite social account audit detects missing customer without reading tokens from JSON", () => {
  const f=fixture();
  try {
    f.db.pragma("foreign_keys = OFF");
    f.db.prepare(`INSERT INTO social_accounts(customer_id,platform,external_account_id,encryption_key_version,connected_at,updated_at)
      VALUES('missing','x','orphan',1,?,?)`).run(now,now);
    const result=auditSocialAccounts({db:f.db,keyring});
    assert.equal(result.checked,1);
    assert.equal(result.issues.some(x=>x.reason==="customer_missing"),true);
  } finally { f.close(); }
});

test("admin stats cache is stored in SQLite and legacy JSON is untouched", () => {
  const f=fixture();
  const old={...process.env};
  try {
    process.env.SNS_POSTER_DATA_SOURCE="sqlite";
    process.env.SNS_POSTER_SQLITE_PATH=f.file;
    process.env.OAUTH_TOKEN_KEY_VERSION="1";
    process.env.OAUTH_TOKEN_KEYS_JSON=JSON.stringify({1:Buffer.alloc(32,9).toString("base64")});
    const dataSource=require("./data/dataSource"); dataSource.closeSqliteContext();
    const adminStats=require("./lib/adminStats");
    const snapshot={month:"2026-10",generatedAt:now,current:2,posts:{},revenue:{}};
    adminStats._cache.writeCache("this_month",snapshot);
    assert.deepEqual(adminStats._cache.readCache("this_month"),snapshot);
    assert.equal(fs.existsSync(path.join(f.dir,"admin_stats_this_month.json")),false);
    dataSource.closeSqliteContext();
  } finally { process.env=old; f.close(); }
});

test("logger writes only to dedicated log directory and rejects path traversal", () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"phase5-log-"));
  const old=process.env.SNS_POSTER_LOG_DIR;
  try {
    process.env.SNS_POSTER_LOG_DIR=path.join(dir,"logs");
    const {createLogger}=require("./lib/logger");
    createLogger("runtime.log").logInfo("fixture");
    assert.equal(fs.existsSync(path.join(dir,"logs","runtime.log")),true);
    assert.equal(fs.existsSync(path.join(dir,"json","runtime.log")),false);
    assert.throws(()=>createLogger("../escape.log"),/must not contain a path/);
  } finally { if(old===undefined)delete process.env.SNS_POSTER_LOG_DIR;else process.env.SNS_POSTER_LOG_DIR=old;fs.rmSync(dir,{recursive:true,force:true}); }
});
