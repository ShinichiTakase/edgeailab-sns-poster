// resolvePriorities（primary/backup解決ロジック）のユニットテスト。純粋関数のためStripe/
// microCMSへの実アクセスは不要。billing.js周りを触るたびに壊れやすい箇所（特に「完全に古い
// 顧客でprimaryが1件も定まらない」自己修復ロジック）を継続的に守るためのリグレッションテスト。
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolvePriorities, findPrimary, findBackup } = require("./paymentMethodPriority");

function pm(id, priority) {
  return { id, metadata: priority ? { priority } : {} };
}

test("明示的にmetadata.priorityが設定されていればそれを使う", () => {
  const resolved = resolvePriorities([pm("pm_1", "primary"), pm("pm_2", "backup")], null);
  assert.equal(findPrimary(resolved).paymentMethod.id, "pm_1");
  assert.equal(findBackup(resolved).paymentMethod.id, "pm_2");
  assert.equal(resolved[0].isLegacyDefault, false);
});

test("既存有償顧客: metadata未設定でもdefault_payment_methodと一致すれば暗黙のprimary", () => {
  const resolved = resolvePriorities([pm("pm_1")], "pm_1");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].priority, "primary");
  assert.equal(resolved[0].isLegacyDefault, true);
});

test("完全に古い顧客: metadata未設定 かつ default_payment_methodも未設定/不一致でも、先頭カードを暗黙primaryとして自己修復する（リグレッション対象）", () => {
  const resolved = resolvePriorities([pm("pm_1")], null);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].priority, "primary", "唯一のカードがbackup扱いのまま埋もれてはいけない");
  assert.equal(resolved[0].isLegacyDefault, true, "自己修復（metadata書き戻し）の対象としてマークされること");
});

test("完全に古い顧客: default_payment_methodが既に存在しないカードを指していても、先頭カードが暗黙primaryになる", () => {
  const resolved = resolvePriorities([pm("pm_1"), pm("pm_2")], "pm_stale_deleted");
  assert.equal(findPrimary(resolved).paymentMethod.id, "pm_1", "Stripe一覧の並び順の先頭が暗黙primaryになること");
  assert.equal(findBackup(resolved).paymentMethod.id, "pm_2");
});

test("明示的なprimaryが既に1件あれば、default_payment_method不一致の他カードを勝手にprimary扱いしない", () => {
  const resolved = resolvePriorities([pm("pm_1", "primary"), pm("pm_2")], "pm_stale_deleted");
  assert.equal(findPrimary(resolved).paymentMethod.id, "pm_1");
  assert.equal(resolved[1].priority, "backup", "未確定カードはbackupへのフェイルセーフ");
});

test("カードが0枚なら空配列を返す", () => {
  assert.deepEqual(resolvePriorities([], null), []);
  assert.equal(findPrimary([]), null);
  assert.equal(findBackup([]), null);
});
