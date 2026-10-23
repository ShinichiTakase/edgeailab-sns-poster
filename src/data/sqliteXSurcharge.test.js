const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-xsur-"));
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
  db.close();
}
const xSurchargeStore = require("../lib/xSurchargeStore");
const { getXSurcharge } = require("../lib/surchargeConfig");
const { closeSqliteContext, getSqliteContext } = require("./dataSource");

test.after(() => { closeSqliteContext(); fs.rmSync(dir, { recursive: true, force: true }); });

test("active版が未設定の間は config/surcharge.json の単価を返す（0円にしない）", () => {
  assert.equal(xSurchargeStore.getCurrentAmountJpy(), getXSurcharge().amount_jpy);
  assert.ok(xSurchargeStore.getCurrentAmountJpy() > 0);
  assert.equal(xSurchargeStore.getCurrentPriceId("basic"), null);
});

test("参照値(ドル)は未設定ならnull、保存後は {amount, updatedAt} を返す", () => {
  assert.equal(xSurchargeStore.getXReferenceUsd(), null);
  xSurchargeStore.setXReferenceUsd(0.2);
  const ref = xSurchargeStore.getXReferenceUsd();
  assert.equal(ref.amount, 0.2);
  assert.match(ref.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("移行で取り込まれた参照値(更新日時あり)も {amount, updatedAt} で返る", () => {
  const { db } = getSqliteContext();
  db.prepare("INSERT INTO x_surcharge_versions(amount,reference_usd,reference_usd_updated_at,effective_at,state,stripe_prices_json,created_at) VALUES (NULL,0.3,?,?,'reference','{}',?)")
    .run("2026-09-05T00:21:20.070Z", "2026-09-05T00:21:20.070Z", "2026-09-05T00:21:20.070Z");
  assert.deepEqual(xSurchargeStore.getXReferenceUsd(), { amount: 0.3, updatedAt: "2026-09-05T00:21:20.070Z" });
});

test("setCurrent後はその金額とPrice IDを返し、再設定で置き換わる", () => {
  xSurchargeStore.setCurrent({ amountJpy: 40, priceIds: { basic: "price_x" } });
  assert.equal(xSurchargeStore.getCurrentAmountJpy(), 40);
  assert.equal(xSurchargeStore.getCurrentPriceId("basic"), "price_x");
  xSurchargeStore.setCurrent({ amountJpy: 0, priceIds: {} });
  assert.equal(xSurchargeStore.getCurrentAmountJpy(), 0);
});
