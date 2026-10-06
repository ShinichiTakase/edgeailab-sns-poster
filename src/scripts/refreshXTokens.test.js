process.env.SNS_POSTER_DATA_SOURCE = "test-legacy";
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
