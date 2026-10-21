const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-dup-"));
const file = path.join(dir, "db.sqlite3");
process.env.SNS_POSTER_DATA_SOURCE = "sqlite";
process.env.SNS_POSTER_SQLITE_PATH = file;
process.env.OAUTH_TOKEN_KEY_VERSION = "1";
process.env.OAUTH_TOKEN_KEYS_JSON = JSON.stringify({ 1: Buffer.alloc(32, 8).toString("base64") });
const { openDatabase } = require("../db/connection");
const { migrate } = require("../db/migrationRunner");
{
  const db = openDatabase(file);
  migrate(db);
  const now = new Date().toISOString();
  for (const [id, slug] of [["idA", "slug-a"], ["idB", "slug-b"]]) {
    db.prepare("INSERT INTO customers(id,slug,primary_email,status,plan,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, slug, `${id}@example.test`, "active", "basic", now, now);
  }
  db.close();
}
const tokenStore = require("../lib/tokenStore");
const { closeSqliteContext } = require("./dataSource");

const tok = (extra) => ({ access_token: "a", refresh_token: "r", token_expires_at: new Date().toISOString(), username: "u", ...extra });

test.after(() => { closeSqliteContext(); fs.rmSync(dir, { recursive: true, force: true }); });

for (const platform of ["x", "threads", "instagram", "linkedin"]) {
  test(`${platform}: self re-auth passes (by slug and id), other customer is blocked with {slug,identifier}`, () => {
    tokenStore.savePlatformTokens("slug-a", platform, tok({ user_id: `${platform}-1` }));
    assert.equal(tokenStore.findDuplicateOwner(platform, [`${platform}-1`], "idA"), null); // 自分(id指定)
    assert.equal(tokenStore.findDuplicateOwner(platform, [`${platform}-1`], "slug-a"), null); // 自分(slug指定)
    assert.deepEqual(tokenStore.findDuplicateOwner(platform, [`${platform}-1`], "idB"), { slug: "slug-a", identifier: `${platform}-1` });
    assert.deepEqual(tokenStore.findDuplicateOwner(platform, [`${platform}-1`], "slug-b"), { slug: "slug-a", identifier: `${platform}-1` });
    assert.equal(tokenStore.findDuplicateOwner(platform, [`${platform}-2`], "idB"), null);
    // 再認可は既存行のUPSERT（トークン更新）として通る
    tokenStore.savePlatformTokens("slug-a", platform, tok({ user_id: `${platform}-1`, access_token: "renewed" }));
    assert.equal(tokenStore.getConnectedEntry("slug-a")[platform].access_token, "renewed");
  });
}

test("facebook: page-level match excludes self, blocks other customer", () => {
  tokenStore.savePlatformTokens("slug-a", "facebook", { user_id: "fbu-1", pages: [{ pageId: "p1", pageName: "P1", pageAccessToken: "t" }, { pageId: "p2", pageName: "P2", pageAccessToken: "t" }], updated_at: new Date().toISOString() });
  assert.equal(tokenStore.findDuplicateOwner("facebook", ["p1", "p2"], "idA"), null);
  assert.equal(tokenStore.findDuplicateOwner("facebook", ["p1"], "slug-a"), null);
  assert.deepEqual(tokenStore.findDuplicateOwner("facebook", ["p9", "p2"], "idB"), { slug: "slug-a", identifier: "p2" });
});

test("disconnected accounts are not duplicates", () => {
  tokenStore.deletePlatformTokensBySlug("slug-a", "x");
  assert.equal(tokenStore.findDuplicateOwner("x", ["x-1"], "idB"), null);
});
