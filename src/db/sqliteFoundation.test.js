const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Worker } = require("node:worker_threads");
const { openDatabase } = require("./connection");
const { migrate, rollbackLast } = require("./migrationRunner");
const { withTransaction } = require("./transaction");
const { createRepositories } = require("../repositories");
const { createScheduledPostUnitOfWork } = require("../services/scheduledPostUnitOfWork");
const { encryptSecret, decryptSecret } = require("../security/tokenCrypto");

const NOW = "2026-10-05T00:00:00.000Z";
const LATER = "2026-10-05T00:10:00.000Z";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sns-poster-sqlite-"));
  const filename = path.join(directory, "fixture.sqlite3");
  const db = openDatabase(filename);
  migrate(db, { now: () => NOW });
  return { db, filename, close() { db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

function seedIdentity(db) {
  db.prepare(`INSERT INTO customers(id,slug,primary_email,status,plan,created_at,updated_at)
    VALUES ('c1','slug-1','owner@example.test','trial','basic',?,?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO users(id,customer_id,email,role,is_owner,created_at,updated_at)
    VALUES ('u1','c1','owner@example.test','管理者',1,?,?)`).run(NOW, NOW);
}

function addPost(repositories, id = "p1") {
  return repositories.scheduledPosts.createWithJob({
    id, customerId: "c1", createdByUserId: "u1", platform: "x", content: "fixture",
    scheduledAt: NOW, approvalState: "none",
  });
}

test("schema creation configures required pragmas and all Phase 1 tables", () => {
  const f = fixture();
  try {
    assert.equal(f.db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(f.db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(f.db.pragma("synchronous", { simple: true }), 2);
    assert.equal(f.db.pragma("busy_timeout", { simple: true }), 10000);
    const tables = new Set(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    for (const name of ["schema_migrations", "customers", "users", "scheduled_posts", "scheduled_post_jobs",
      "scheduled_post_effects", "billing_meter_events", "oauth_states", "audit_logs"]) assert.ok(tables.has(name), name);
  } finally { f.close(); }
});

test("migration is repeatable and checksum remains stable", () => {
  const f = fixture();
  try {
    migrate(f.db, { now: () => LATER });
    assert.equal(f.db.prepare("SELECT count(*) n FROM schema_migrations").get().n, 4);
  } finally { f.close(); }
});

test("last migration rolls back and can be reapplied", () => {
  const f = fixture();
  try {
    assert.equal(rollbackLast(f.db), "004");
    assert.equal(f.db.prepare("SELECT count(*) n FROM schema_migrations").get().n, 3);
    migrate(f.db);
    assert.ok(f.db.prepare("SELECT name FROM sqlite_master WHERE name='customers'").get());
  } finally { f.close(); }
});

test("foreign keys reject orphan records", () => {
  const f = fixture();
  try {
    assert.throws(() => f.db.prepare(`INSERT INTO users(id,customer_id,email,role,created_at,updated_at)
      VALUES ('u','missing','x@example.test','管理者',?,?)`).run(NOW, NOW), /FOREIGN KEY/);
  } finally { f.close(); }
});

test("unique constraints reject duplicate normalized email", () => {
  const f = fixture();
  try {
    seedIdentity(f.db);
    assert.throws(() => f.db.prepare(`INSERT INTO users(id,customer_id,email,role,created_at,updated_at)
      VALUES ('u2','c1','OWNER@example.test','編集者',?,?)`).run(NOW, NOW), /UNIQUE/);
  } finally { f.close(); }
});

test("check constraints reject invalid job state", () => {
  const f = fixture();
  try {
    seedIdentity(f.db);
    const repositories = createRepositories(f.db, { now: () => NOW });
    addPost(repositories);
    assert.throws(() => f.db.prepare("UPDATE scheduled_post_jobs SET state='unknown' WHERE scheduled_post_id='p1'").run(), /CHECK/);
  } finally { f.close(); }
});

test("transaction rolls back all writes on error", () => {
  const f = fixture();
  try {
    assert.throws(() => withTransaction(f.db, () => {
      f.db.prepare(`INSERT INTO customers(id,slug,primary_email,status,plan,created_at,updated_at)
        VALUES ('c1','s','a@example.test','trial','basic',?,?)`).run(NOW, NOW);
      throw new Error("rollback");
    }), /rollback/);
    assert.equal(f.db.prepare("SELECT count(*) n FROM customers").get().n, 0);
  } finally { f.close(); }
});

test("transaction rejects asynchronous callbacks", () => {
  const f = fixture();
  try {
    assert.throws(() => withTransaction(f.db, async () => true), /must be synchronous/);
    assert.equal(f.db.inTransaction, false);
  } finally { f.close(); }
});

test("two independent connections can claim a due job only once", () => {
  const f = fixture();
  const second = openDatabase(f.filename);
  try {
    seedIdentity(f.db);
    const firstRepos = createRepositories(f.db, { now: () => NOW, uuid: () => "attempt-1" });
    const secondRepos = createRepositories(second, { now: () => NOW, uuid: () => "attempt-2" });
    addPost(firstRepos);
    const first = firstRepos.jobs.claimNext({ workerId: "worker-1", leaseExpiresAt: LATER, dueAt: NOW });
    const other = secondRepos.jobs.claimNext({ workerId: "worker-2", leaseExpiresAt: LATER, dueAt: NOW });
    assert.equal(first.scheduled_post_id, "p1");
    assert.equal(other, null);
    assert.equal(f.db.prepare("SELECT count(*) n FROM scheduled_post_attempts").get().n, 1);
  } finally { second.close(); f.close(); }
});

test("failed jobs require a non-null due retry timestamp before claim", () => {
  const f = fixture();
  try {
    seedIdentity(f.db);
    const repos = createRepositories(f.db, { now: () => NOW, uuid: () => "retry-attempt" });
    addPost(repos);
    f.db.prepare("UPDATE scheduled_post_jobs SET state='failed',next_attempt_at=NULL WHERE scheduled_post_id='p1'").run();
    assert.equal(repos.jobs.claimNext({ workerId: "worker", leaseExpiresAt: LATER, dueAt: NOW }), null);
    f.db.prepare("UPDATE scheduled_post_jobs SET next_attempt_at=? WHERE scheduled_post_id='p1'").run(NOW);
    assert.equal(repos.jobs.claimNext({ workerId: "worker", leaseExpiresAt: LATER, dueAt: NOW }).scheduled_post_id, "p1");
  } finally { f.close(); }
});

test("simultaneous worker threads produce one claim", async () => {
  const f = fixture();
  try {
    seedIdentity(f.db);
    addPost(createRepositories(f.db, { now: () => NOW }));
    const repoPath = path.join(__dirname, "../repositories");
    const connectionPath = path.join(__dirname, "connection");
    const source = `const {parentPort,workerData}=require('node:worker_threads');
      const {openDatabase}=require(workerData.connectionPath);const {createRepositories}=require(workerData.repoPath);
      const db=openDatabase(workerData.filename);parentPort.once('message',()=>{try{const r=createRepositories(db,{now:()=>workerData.now}).jobs.claimNext({workerId:workerData.worker,leaseExpiresAt:workerData.later,dueAt:workerData.now});parentPort.postMessage(r?1:0)}catch(e){parentPort.postMessage({error:e.message})}finally{db.close()}});`;
    const workers = ["w1", "w2"].map((worker) => new Worker(source, { eval: true,
      workerData: { filename: f.filename, repoPath, connectionPath, now: NOW, later: LATER, worker } }));
    const results = await Promise.all(workers.map((worker) => new Promise((resolve, reject) => {
      worker.once("message", resolve); worker.once("error", reject); worker.postMessage("start");
    })));
    assert.deepEqual(results.sort(), [0, 1]);
  } finally { f.close(); }
});

test("expired lease before request is retryable", () => {
  const f = fixture();
  try {
    seedIdentity(f.db); const repos = createRepositories(f.db, { now: () => NOW, uuid: () => "a1" }); addPost(repos);
    repos.jobs.claimNext({ workerId: "w", leaseExpiresAt: "2026-10-05T00:01:00.000Z", dueAt: NOW });
    assert.deepEqual(repos.jobs.recoverExpiredLeases({ expiredBefore: LATER }), { ambiguous: 0, retryable: 1 });
    assert.equal(f.db.prepare("SELECT state FROM scheduled_post_jobs").get().state, "pending");
  } finally { f.close(); }
});

test("expired lease after request becomes ambiguous and cannot auto-retry", () => {
  const f = fixture();
  try {
    seedIdentity(f.db); const repos = createRepositories(f.db, { now: () => NOW, uuid: () => "a1" }); addPost(repos);
    repos.jobs.claimNext({ workerId: "w", leaseExpiresAt: "2026-10-05T00:01:00.000Z", dueAt: NOW });
    repos.jobs.markRequestStarted({ scheduledPostId: "p1", workerId: "w", attemptId: "a1", at: NOW });
    assert.deepEqual(repos.jobs.recoverExpiredLeases({ expiredBefore: LATER }), { ambiguous: 1, retryable: 0 });
    assert.equal(f.db.prepare("SELECT state FROM scheduled_post_jobs").get().state, "ambiguous");
    assert.equal(repos.jobs.claimNext({ workerId: "w2", leaseExpiresAt: LATER, dueAt: LATER }), null);
  } finally { f.close(); }
});

test("confirmed job follows pending-processing-sent-done and cancel is limited to unsent jobs", () => {
  const f = fixture();
  try {
    seedIdentity(f.db); const repos = createRepositories(f.db, { now: () => NOW, uuid: () => "a1" }); addPost(repos);
    repos.jobs.claimNext({ workerId: "w", leaseExpiresAt: LATER, dueAt: NOW });
    repos.jobs.markRequestStarted({ scheduledPostId: "p1", workerId: "w", attemptId: "a1" });
    repos.jobs.markSent({ scheduledPostId: "p1", workerId: "w", attemptId: "a1", externalPostId: "post-1" });
    assert.equal(repos.jobs.cancel("p1"), false);
    repos.effects.ensureAll("p1");
    f.db.prepare("UPDATE scheduled_post_effects SET state='done'").run();
    assert.equal(repos.jobs.markDone("p1"), true);
    assert.equal(f.db.prepare("SELECT state FROM scheduled_post_jobs WHERE scheduled_post_id='p1'").get().state, "done");
    addPost(repos, "p2");
    assert.equal(repos.jobs.cancel("p2"), true);
    assert.equal(f.db.prepare("SELECT state FROM scheduled_post_jobs WHERE scheduled_post_id='p2'").get().state, "canceled");
  } finally { f.close(); }
});

test("effect ledger is idempotent and claim is exclusive", () => {
  const f = fixture();
  try {
    seedIdentity(f.db); const repos = createRepositories(f.db, { now: () => NOW }); addPost(repos);
    const a = repos.effects.ensure({ scheduledPostId: "p1", effectType: "email", idempotencyKey: "email:p1" });
    const b = repos.effects.ensure({ scheduledPostId: "p1", effectType: "email", idempotencyKey: "email:p1" });
    assert.equal(a.id, b.id);
    assert.ok(repos.effects.claim({ effectId: a.id, workerId: "w1", leaseExpiresAt: LATER, at: NOW }));
    assert.equal(repos.effects.claim({ effectId: a.id, workerId: "w2", leaseExpiresAt: LATER, at: NOW }), null);
  } finally { f.close(); }
});

test("confirmed send creates one posting log, effects, and meter event", () => {
  const f = fixture();
  try {
    seedIdentity(f.db); const repos = createRepositories(f.db, { now: () => NOW }); addPost(repos);
    const service = createScheduledPostUnitOfWork(f.db, repos, { now: () => NOW, uuid: () => "meter-1" });
    const args = { scheduledPostId: "p1", customerId: "c1", createdByUserId: "u1", platform: "x", content: "fixture", externalPostId: "x-1" };
    service.recordConfirmedSend(args); service.recordConfirmedSend(args);
    assert.equal(f.db.prepare("SELECT count(*) n FROM posting_logs").get().n, 1);
    assert.equal(f.db.prepare("SELECT count(*) n FROM scheduled_post_effects").get().n, 5);
    assert.equal(f.db.prepare("SELECT count(*) n FROM billing_meter_events").get().n, 1);
  } finally { f.close(); }
});

test("meter idempotency key prevents duplicate billing event", () => {
  const f = fixture();
  try {
    seedIdentity(f.db); const repos = createRepositories(f.db, { now: () => NOW });
    const event = { id: "m1", idempotencyKey: "same", customerId: "c1", eventName: "sns_post", quantity: 1 };
    repos.meterEvents.ensure(event); repos.meterEvents.ensure({ ...event, id: "m2" });
    assert.equal(f.db.prepare("SELECT count(*) n FROM billing_meter_events").get().n, 1);
  } finally { f.close(); }
});

test("OAuth state can be consumed once and secrets are encrypted", () => {
  const f = fixture();
  try {
    seedIdentity(f.db);
    const keyring = { currentVersion: 1, keys: new Map([[1, crypto.randomBytes(32)]]) };
    const repos = createRepositories(f.db, { now: () => NOW, keyring });
    repos.oauthStates.create({ state: "raw-state", customerId: "c1", platform: "x", codeVerifier: "secret-verifier",
      payload: { returnTo: "/account" }, expiresAt: LATER });
    const stored = f.db.prepare("SELECT * FROM oauth_states").get();
    assert.equal(stored.state_hash.includes("raw-state"), false);
    assert.equal(stored.code_verifier_ciphertext.includes("secret-verifier"), false);
    assert.deepEqual(repos.oauthStates.consume("raw-state", NOW), { customerId: "c1", platform: "x",
      codeVerifier: "secret-verifier", payload: { returnTo: "/account" } });
    assert.equal(repos.oauthStates.consume("raw-state", NOW), null);
  } finally { f.close(); }
});

test("AES-256-GCM detects tampering and supports key rotation", () => {
  const oldKey = crypto.randomBytes(32); const newKey = crypto.randomBytes(32);
  const oldRing = { currentVersion: 1, keys: new Map([[1, oldKey]]) };
  const rotated = { currentVersion: 2, keys: new Map([[1, oldKey], [2, newKey]]) };
  const oldCiphertext = encryptSecret("token", oldRing, "account");
  assert.equal(decryptSecret(oldCiphertext, rotated, "account"), "token");
  const parts = oldCiphertext.split(".");
  parts[3] = `${parts[3][0] === "A" ? "B" : "A"}${parts[3].slice(1)}`;
  const changed = parts.join(".");
  assert.throws(() => decryptSecret(changed, rotated, "account"));
  assert.match(encryptSecret("new-token", rotated, "account"), /^v2\./);
});

test("repository factory satisfies declared contracts", () => {
  const f = fixture();
  try {
    const keyring = { currentVersion: 1, keys: new Map([[1, crypto.randomBytes(32)]]) };
    const repos = createRepositories(f.db, { keyring });
    for (const name of ["scheduledPosts", "jobs", "effects", "meterEvents", "oauthStates"]) assert.ok(repos[name]);
  } finally { f.close(); }
});
