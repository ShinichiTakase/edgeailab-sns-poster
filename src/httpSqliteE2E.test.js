const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const { openDatabase } = require("./db/connection");
const { migrate } = require("./db/migrationRunner");

test("isolated SQLite HTTP auth/dashboard/CRUD/admin/OAuth and scheduler flow", { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sns-poster-http-e2e-"));
  const filename = path.join(dir, "shadow-clone.sqlite3");
  const logDir = path.join(dir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const key = crypto.randomBytes(32).toString("base64");
  Object.assign(process.env, {
    SNS_POSTER_DATA_SOURCE: "sqlite", SNS_POSTER_SQLITE_PATH: filename, SNS_POSTER_LOG_DIR: logDir,
    OAUTH_TOKEN_KEY_VERSION: "1", OAUTH_TOKEN_KEYS_JSON: JSON.stringify({ 1: key }),
    JWT_SECRET: "http-e2e-only-jwt-secret", X_CLIENT_ID: "fixture-client", X_CLIENT_SECRET: "fixture-secret",
    X_REDIRECT_URI: "http://127.0.0.1/oauth/x/callback", APP_BASE_URL: "http://127.0.0.1",
  });
  delete process.env.STRIPE_SECRET_KEY;

  const setup = openDatabase(filename);
  migrate(setup);
  const now = new Date().toISOString();
  const trialEnds = new Date(Date.now() + 30 * 86400000).toISOString();
  setup.prepare(`INSERT INTO customers(id,slug,primary_email,contact_name,status,plan,is_verified,trial_ends_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("c1", "fixture", "owner@example.test", "Owner", "trial", "basic", 1, trialEnds, now, now);
  setup.prepare(`INSERT INTO users(id,customer_id,email,password_hash,role,is_owner,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run("u1", "c1", "owner@example.test", "fixture-hash", "管理者", 1, now, now);
  setup.prepare(`INSERT INTO users(id,customer_id,email,password_hash,role,is_owner,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run("u2", "c1", "viewer@example.test", "fixture-hash", "閲覧者", 0, now, now);
  setup.prepare(`INSERT INTO notifications(id,customer_id,type,title,body,dedupe_key,created_at)
    VALUES ('n1','c1','info','Fixture','Body','fixture:n1',?)`).run(now);
  setup.close();

  const legacyNames = new Set(["client_tokens.json", "sns_history.json", "scheduled_post_retries.json", "posting_log_origins.json", "announcements.json", "announcement_reads.json", "x_surcharge_current.json"]);
  const observed = { microcms: 0, legacyJson: 0, realExternal: 0, mockedX: 0 };
  const originalRead = fs.readFileSync;
  const originalWrite = fs.writeFileSync;
  const originalAppend = fs.appendFileSync;
  const watch = (original) => function watched(file, ...args) {
    if (legacyNames.has(path.basename(String(file)))) observed.legacyJson += 1;
    return original.call(fs, file, ...args);
  };
  fs.readFileSync = watch(originalRead);
  fs.writeFileSync = watch(originalWrite);
  fs.appendFileSync = watch(originalAppend);

  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "bcrypt") return { compare: async (password, hash) => password === "Correct1!" && hash === "fixture-hash", hash: async () => "fixture-hash" };
    return originalLoad.call(this, request, parent, isMain);
  };
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes("microcms")) { observed.microcms += 1; throw new Error("microCMS access blocked by E2E"); }
    if (target === "https://api.x.com/2/oauth2/token") {
      observed.mockedX += 1;
      return { ok: true, status: 200, json: async () => ({ access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", expires_in: 3600 }) };
    }
    if (target === "https://api.x.com/2/users/me") {
      observed.mockedX += 1;
      return { ok: true, status: 200, json: async () => ({ data: { id: "x-fixture-id", username: "fixture_user" } }) };
    }
    observed.realExternal += 1;
    throw new Error(`unexpected external access: ${target}`);
  };

  let server;
  try {
    const { createApp } = require("./index");
    Module._load = originalLoad;
    const wrapper = express();
    wrapper.use("/api/admin", (req, res, next) => {
      if (req.headers.authorization === `Basic ${Buffer.from("fixture-admin:fixture-password").toString("base64")}`) return next();
      return res.status(401).json({ error: "admin_auth_required" });
    });
    wrapper.use(createApp());
    server = await new Promise((resolve) => { const s = wrapper.listen(0, "127.0.0.1", () => resolve(s)); });
    const port = server.address().port;
    let ownerCookie = "";
    let viewerCookie = "";
    const request = (method, route, body, cookie, headers = {}) => new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({ host: "127.0.0.1", port, method, path: route, headers: {
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        ...(cookie ? { cookie } : {}), ...headers,
      } }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json; try { json = JSON.parse(text); } catch { json = null; }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      req.on("error", reject); if (payload) req.write(payload); req.end();
    });
    const cookieOf = (response) => String(response.headers["set-cookie"]?.[0] || "").split(";")[0];

    assert.equal((await request("GET", "/api/auth/me")).status, 401);
    assert.equal((await request("POST", "/api/auth/login", { email: "owner@example.test", password: "wrong" })).status, 401);
    let response = await request("POST", "/api/auth/login", { email: "owner@example.test", password: "Correct1!" });
    assert.equal(response.status, 200); ownerCookie = cookieOf(response); assert.ok(ownerCookie);
    assert.equal((await request("GET", "/api/auth/me", undefined, ownerCookie)).status, 200);
    assert.equal((await request("GET", "/api/auth/me", undefined, ownerCookie)).json.email, "owner@example.test");
    response = await request("POST", "/api/auth/login", { email: "viewer@example.test", password: "Correct1!" });
    assert.equal(response.status, 200); viewerCookie = cookieOf(response);
    assert.equal((await request("GET", "/api/schedules", undefined, viewerCookie)).status, 403);

    for (const route of ["/api/schedules", "/api/posts/list", "/api/announcements"]) assert.equal((await request("GET", route, undefined, ownerCookie)).status, 200, route);

    const schedule = { name: "HTTP fixture", platforms: ["x"], urlMode: false, notifyEmail: false,
      startDate: "2026-10-06", endDate: null, weekdays: ["mon"], dailyPostCount: 1,
      slot1Start: "09:00", slot1End: "10:00", slot2Start: "", slot2End: "", slot3Start: "", slot3End: "" };
    response = await request("POST", "/api/schedules", schedule, ownerCookie);
    assert.equal(response.status, 200, response.text); const scheduleId = response.json.id;
    assert.equal((await request("GET", `/api/schedules/${scheduleId}`, undefined, ownerCookie)).status, 200);
    assert.equal((await request("PATCH", `/api/schedules/${scheduleId}`, { ...schedule, name: "HTTP fixture updated" }, ownerCookie)).status, 200);
    assert.equal((await request("GET", `/api/schedules/${scheduleId}`, undefined, ownerCookie)).json.name, "HTTP fixture updated");

    assert.equal((await request("GET", "/api/admin/customers", undefined, ownerCookie)).status, 401);
    const basic = { authorization: `Basic ${Buffer.from("fixture-admin:fixture-password").toString("base64")}` };
    assert.equal((await request("GET", "/api/admin/customers", undefined, "", basic)).status, 200);
    assert.equal((await request("GET", "/api/admin/customers/c1", undefined, "", basic)).status, 200);

    response = await request("GET", "/oauth/x/authorize", undefined, ownerCookie);
    assert.equal(response.status, 302); const state = new URL(response.headers.location).searchParams.get("state"); assert.ok(state);
    assert.equal((await request("GET", `/oauth/x/callback?code=fixture-code&state=${state}`)).status, 200);
    assert.equal((await request("GET", `/oauth/x/callback?code=fixture-code&state=${state}`)).status, 400);
    response = await request("GET", "/api/sns-connections", undefined, ownerCookie);
    assert.equal(response.status, 200); assert.equal(response.json.platforms.x.connected, true);

    const scheduledAt = new Date(Date.now() + 120000).toISOString();
    response = await request("POST", "/api/posts/schedule", { platforms: ["x"], texts: { x: "HTTP to scheduler fixture" }, scheduledAt, notifyEmail: false }, ownerCookie);
    assert.equal(response.status, 200, response.text); const postId = response.json.results.x.scheduledPostId; assert.ok(postId);

    const { getSqliteContext } = require("./data/dataSource");
    const { createSqliteScheduledPostRunner } = require("./services/sqliteScheduledPostRunner");
    const runnerNow = new Date(Date.parse(scheduledAt) + 1000).toISOString();
    const effects = { posting_log: () => ({}), trial_post_count: () => ({}), notification: () => ({}), stripe_meter: async () => ({ externalReference: "mock-meter" }), email: async () => ({ externalReference: "mock-mail" }) };
    const runner = createSqliteScheduledPostRunner(getSqliteContext().db, { now: () => runnerNow,
      postToPlatform: async () => ({ id: "mock-external-post" }), effectHandlers: effects, workerId: "http-e2e-runner" });
    assert.deepEqual(await runner.runOne(), { scheduledPostId: postId, state: "done" });
    response = await request("GET", "/api/posts/list", undefined, ownerCookie);
    assert.equal(response.status, 200); assert.ok(response.json.rows.some((post) => post.content === "HTTP to scheduler fixture"));

    response = await request("POST", "/api/sns-connections/x/disconnect", {}, ownerCookie);
    assert.equal(response.status, 200); assert.equal((await request("GET", "/api/sns-connections", undefined, ownerCookie)).json.platforms.x.connected, false);
    assert.equal((await request("DELETE", `/api/schedules/${scheduleId}`, undefined, ownerCookie)).status, 200);
    assert.equal((await request("GET", `/api/schedules/${scheduleId}`, undefined, ownerCookie)).status, 404);
    response = await request("POST", "/api/auth/logout", {}, ownerCookie);
    assert.equal(response.status, 200);

    const db = getSqliteContext().db;
    const token = db.prepare("SELECT access_token_ciphertext FROM social_accounts WHERE platform='x'").get();
    assert.ok(token.access_token_ciphertext.startsWith("v1."));
    assert.equal(token.access_token_ciphertext.includes("fixture-access-token"), false);
    assert.equal(db.prepare("SELECT consumed_at FROM oauth_states WHERE state_hash IS NOT NULL ORDER BY created_at LIMIT 1").get().consumed_at != null, true);
    assert.equal(db.prepare("SELECT state FROM scheduled_post_jobs WHERE scheduled_post_id=?").get(postId).state, "done");
    assert.deepEqual(observed, { microcms: 0, legacyJson: 0, realExternal: 0, mockedX: 2 });
  } finally {
    Module._load = originalLoad;
    global.fetch = originalFetch;
    fs.readFileSync = originalRead; fs.writeFileSync = originalWrite; fs.appendFileSync = originalAppend;
    if (server) await new Promise((resolve) => server.close(resolve));
    try { require("./data/dataSource").closeSqliteContext(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
