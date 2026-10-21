process.env.SNS_POSTER_DATA_SOURCE = "test-legacy";
process.env.X_REFRESH_STATE_PATH = require("path").join(require("os").tmpdir(), `x-refresh-state-${process.pid}-${Date.now()}.json`);
const assert = require("node:assert/strict");
const test = require("node:test");

test("SQLite slug/id aliases refresh one X account only once", async () => {
  const tokenStore = require("../lib/tokenStore");
  const mailer = require("../lib/mailer");
  const originalLoad = tokenStore.loadStore;
  const originalSave = tokenStore.savePlatformTokens;
  const originalNotify = mailer.notifyFailure;
  const originalFetch = global.fetch;
  const entry = { user_id: "x-user", username: "name", access_token: "old-access", refresh_token: "old-refresh",
    token_expires_at: "2020-01-01T00:00:00.000Z" };
  let fetches = 0;
  tokenStore.loadStore = () => ({ slug: { x: entry }, customerId: { x: entry } });
  tokenStore.savePlatformTokens = () => true;
  mailer.notifyFailure = async () => { throw new Error("unexpected notification"); };
  global.fetch = async () => { fetches++; return { ok: true, json: async () => ({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 7200 }) }; };
  delete require.cache[require.resolve("./refreshXTokens")];
  try {
    const { main } = require("./refreshXTokens");
    await main();
    assert.equal(fetches, 1);
  } finally {
    tokenStore.loadStore = originalLoad;
    tokenStore.savePlatformTokens = originalSave;
    mailer.notifyFailure = originalNotify;
    global.fetch = originalFetch;
    delete require.cache[require.resolve("./refreshXTokens")];
  }
});

function setup(entryOverrides = {}) {
  const tokenStore = require("../lib/tokenStore");
  const mailer = require("../lib/mailer");
  const saved = { load: tokenStore.loadStore, save: tokenStore.savePlatformTokens, notify: mailer.notifyFailure, fetch: global.fetch };
  const entry = { user_id: "x-user", access_token: "old-access", refresh_token: "old-refresh", token_expires_at: "2020-01-01T00:00:00.000Z", ...entryOverrides };
  const mails = [];
  const saves = [];
  tokenStore.loadStore = () => ({ slug1: { x: entry } });
  tokenStore.savePlatformTokens = (...a) => { saves.push(a); return true; };
  mailer.notifyFailure = async (subject, text) => { mails.push({ subject, text }); };
  delete require.cache[require.resolve("./refreshXTokens")];
  const restore = () => {
    tokenStore.loadStore = saved.load; tokenStore.savePlatformTokens = saved.save;
    mailer.notifyFailure = saved.notify; global.fetch = saved.fetch;
    delete require.cache[require.resolve("./refreshXTokens")];
    try { require("fs").unlinkSync(process.env.X_REFRESH_STATE_PATH); } catch {}
  };
  return { mails, saves, restore };
}
const networkFail = () => { const e = new TypeError("fetch failed"); e.cause = Object.assign(new Error("getaddrinfo EAI_AGAIN api.x.com"), { code: "EAI_AGAIN" }); return e; };
const noSleep = { sleepFn: async () => {} };

test("fetch failed: retries 3x per run, silent until 3 consecutive runs, no reauth link, resets on success", async () => {
  const { mails, restore } = setup();
  let fetches = 0, mode = "fail";
  global.fetch = async () => { fetches++; if (mode === "fail") throw networkFail(); return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 7200 }) }; };
  try {
    const { main } = require("./refreshXTokens");
    await main(noSleep);
    assert.equal(fetches, 3);
    assert.equal(mails.length, 0);
    await main(noSleep);
    assert.equal(mails.length, 0);
    await main(noSleep);
    assert.equal(fetches, 9);
    assert.equal(mails.length, 1);
    assert.match(mails[0].text, /EAI_AGAIN/);
    assert.doesNotMatch(mails[0].text, /oauth\/x\/authorize/);
    await main(noSleep); // 4回目は再通知しない
    assert.equal(mails.length, 1);
    mode = "ok";
    await main(noSleep); // 成功でリセット
    mode = "fail";
    await main(noSleep); await main(noSleep);
    assert.equal(mails.length, 1);
  } finally { restore(); }
});

test("invalid_grant (400): no retry, immediate reauth mail once, secrets not leaked, body excerpt <=200", async () => {
  const { mails, saves, restore } = setup();
  let fetches = 0;
  const body = JSON.stringify({ error: "invalid_grant", error_description: "x".repeat(500), refresh_token: "SECRET-REFRESH" });
  global.fetch = async () => { fetches++; return { ok: false, status: 400, text: async () => body }; };
  try {
    const { main } = require("./refreshXTokens");
    await main(noSleep);
    assert.equal(fetches, 1);
    assert.equal(mails.length, 1);
    assert.match(mails[0].text, /oauth\/x\/authorize\?slug=slug1/);
    assert.match(mails[0].text, /HTTPステータス: 400/);
    assert.doesNotMatch(mails[0].text, /SECRET-REFRESH|old-refresh/);
    const line = mails[0].text.split("\n").find((l) => l.startsWith("本文"));
    assert.ok(line.length < 260);
    assert.equal(saves.length, 0);
    await main(noSleep); // 同じ失敗の再送はしない
    assert.equal(mails.length, 1);
  } finally { restore(); }
});

test("rotated refresh_token is saved from the response", async () => {
  const { saves, restore } = setup();
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ access_token: "new-a", refresh_token: "new-r", expires_in: 7200 }) });
  try {
    await require("./refreshXTokens").main(noSleep);
    assert.equal(saves[0][2].refresh_token, "new-r");
  } finally { restore(); }
});

for (const [status, bodyObj] of [[400, { error: "invalid_request" }], [401, { error: "unauthorized" }], [401, null]]) {
  test(`HTTP ${status} (${bodyObj ? bodyObj.error : "non-JSON body"}) is treated as likely revoked: immediate reauth mail once`, async () => {
    const { mails, restore } = setup();
    let fetches = 0;
    global.fetch = async () => { fetches++; return { ok: false, status, text: async () => (bodyObj ? JSON.stringify({ ...bodyObj, refresh_token: "SECRET-R" }) : "<html>Unauthorized</html>") }; };
    try {
      const { main } = require("./refreshXTokens");
      await main(noSleep);
      assert.equal(fetches, 1);
      assert.equal(mails.length, 1);
      assert.match(mails[0].text, /oauth\/x\/authorize\?slug=slug1/);
      assert.match(mails[0].text, new RegExp(`HTTPステータス: ${status}`));
      assert.doesNotMatch(mails[0].text, /SECRET-R|old-refresh/);
      await main(noSleep);
      assert.equal(mails.length, 1);
    } finally { restore(); }
  });
}

for (const status of [429, 500, 503]) {
  test(`HTTP ${status}: no reauth mail; notified only after 3 consecutive runs, without link`, async () => {
    const { mails, restore } = setup();
    global.fetch = async () => ({ ok: false, status, text: async () => JSON.stringify({ title: "Service" }) });
    try {
      const { main } = require("./refreshXTokens");
      await main(noSleep); await main(noSleep);
      assert.equal(mails.length, 0);
      await main(noSleep);
      assert.equal(mails.length, 1);
      assert.match(mails[0].text, new RegExp(`HTTPステータス: ${status}`));
      assert.doesNotMatch(mails[0].text, /oauth\/x\/authorize/);
    } finally { restore(); }
  });
}
