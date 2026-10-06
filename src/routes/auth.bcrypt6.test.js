const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const bcrypt = require("bcrypt");
const { openDatabase } = require("../db/connection");
const { migrate } = require("../db/migrationRunner");

const LEGACY_BCRYPT5_HASH = "$2b$10$r1dpIA3Ia7P.1UG3gHycR.Jts3evQ3oKDZ/VCAb.pDB0kpq9cMZVi";
const LEGACY_PASSWORD = "LegacyPass-2026!";

test("bcrypt 6はbcrypt 5 hash・新規hash・Unicode・不正passwordを処理できる", async () => {
  assert.equal(await bcrypt.compare(LEGACY_PASSWORD, LEGACY_BCRYPT5_HASH), true);
  assert.equal(await bcrypt.compare("wrong-password", LEGACY_BCRYPT5_HASH), false);
  const unicode = "日本語Password-2026!";
  const hash = await bcrypt.hash(unicode, 12);
  assert.match(hash, /^\$2[aby]\$12\$/);
  assert.equal(await bcrypt.compare(unicode, hash), true);
  assert.equal(await bcrypt.compare(`${unicode}x`, hash), false);
});

test("既存hashでlogin後、signup・password変更・resetにmigrationなしで利用できる", { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sns-poster-bcrypt6-http-"));
  const database = path.join(dir, "auth.sqlite3");
  Object.assign(process.env, {
    SNS_POSTER_DATA_SOURCE: "sqlite",
    SNS_POSTER_SQLITE_PATH: database,
    SNS_POSTER_LOG_DIR: path.join(dir, "logs"),
    OAUTH_TOKEN_KEY_VERSION: "1",
    OAUTH_TOKEN_KEYS_JSON: JSON.stringify({ 1: crypto.randomBytes(32).toString("base64") }),
    JWT_SECRET: "bcrypt6-http-test-only",
    SMTP_HOST: "",
    SMTP_USER: "",
    SMTP_PASSWORD: "",
    SMTP_FROM: "",
  });
  fs.mkdirSync(process.env.SNS_POSTER_LOG_DIR, { recursive: true });

  const setup = openDatabase(database);
  migrate(setup);
  const now = new Date().toISOString();
  setup.prepare(`INSERT INTO customers(id,slug,primary_email,contact_name,status,plan,is_verified,trial_ends_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run("legacy-customer", "legacy-customer", "legacy@example.test", "Legacy", "trial", "basic", 1, "2099-01-01T00:00:00.000Z", now, now);
  setup.prepare(`INSERT INTO users(id,customer_id,email,password_hash,role,is_owner,session_version,created_at,updated_at)
    VALUES (?,?,?,?,?,1,1,?,?)`).run("legacy-user", "legacy-customer", "legacy@example.test", LEGACY_BCRYPT5_HASH, "管理者", now, now);
  setup.close();

  const { createApp } = require("../index");
  const customerStore = require("../lib/customerStore");
  let server;
  try {
    server = await new Promise((resolve) => {
      const instance = createApp().listen(0, "127.0.0.1", () => resolve(instance));
    });
    const port = server.address().port;
    const request = (route, body, cookie = "") => new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body));
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: route, headers: {
        "content-type": "application/json", "content-length": payload.length, ...(cookie ? { cookie } : {}),
      } }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8"), cookie: String(res.headers["set-cookie"]?.[0] || "").split(";")[0] }));
      });
      req.on("error", reject);
      req.end(payload);
    });

    assert.equal((await request("/api/auth/login", { email: "legacy@example.test", password: "wrong-password" })).status, 401);
    let response = await request("/api/auth/login", { email: "legacy@example.test", password: LEGACY_PASSWORD });
    assert.equal(response.status, 200, response.body);
    assert.ok(response.cookie);

    response = await request("/api/auth/change-password", {
      currentPassword: LEGACY_PASSWORD,
      newPassword: "ChangedPass-2026!",
      newPasswordConfirm: "ChangedPass-2026!",
    }, response.cookie);
    assert.equal(response.status, 200, response.body);
    assert.equal((await request("/api/auth/login", { email: "legacy@example.test", password: LEGACY_PASSWORD })).status, 401);
    assert.equal((await request("/api/auth/login", { email: "legacy@example.test", password: "ChangedPass-2026!" })).status, 200);

    await customerStore.setPasswordResetToken("legacy-customer", "legacy-user", "known-reset-token", "2099-01-01T00:00:00.000Z");
    response = await request("/api/auth/reset-password", { token: "known-reset-token", password: "日本語Reset-2026!" });
    assert.equal(response.status, 200, response.body);
    assert.equal((await request("/api/auth/login", { email: "legacy@example.test", password: "日本語Reset-2026!" })).status, 200);

    response = await request("/api/auth/signup", {
      email: "unicode@example.test",
      password: "日本語Signup-2026!",
      plan: "basic",
      contactName: "Unicode Fixture",
      companyName: "",
    });
    assert.equal(response.status, 200, response.body);
    assert.equal((await request("/api/auth/login", { email: "unicode@example.test", password: "日本語Signup-2026!" })).status, 200);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    try { require("../data/dataSource").closeSqliteContext(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
