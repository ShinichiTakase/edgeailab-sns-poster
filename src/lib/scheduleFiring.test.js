// isSlotElapsed / pickRandomTimeInSlot(now指定) のリグレッションテスト。
// 2026-09-02、日中に新規作成したスケジュールの「既に終了時刻を過ぎた枠」まで
// まとめて即時投稿されてしまう不具合を修正した際に追加。
const test = require("node:test");
const assert = require("node:assert/strict");

const { isSlotElapsed, pickRandomTimeInSlot, orderTextsForRoundRobin, dateOnly } = require("./scheduleFiring");

const TODAY = dateOnly(new Date("2026-09-02T00:00:00+09:00"));
const slot = { start: "07:00", end: "10:00" };

test("isSlotElapsed: 枠の終了時刻を過ぎていればtrue", () => {
  const now = new Date("2026-09-02T16:05:00+09:00");
  assert.equal(isSlotElapsed(TODAY, slot, now), true);
});

test("isSlotElapsed: 枠の途中（開始後・終了前）はfalse", () => {
  const now = new Date("2026-09-02T08:00:00+09:00");
  assert.equal(isSlotElapsed(TODAY, slot, now), false);
});

test("isSlotElapsed: 枠の開始前はfalse", () => {
  const now = new Date("2026-09-02T05:00:00+09:00");
  assert.equal(isSlotElapsed(TODAY, slot, now), false);
});

test("pickRandomTimeInSlot: nowが枠開始前なら従来通り枠全体から選ぶ", () => {
  const now = new Date("2026-09-02T05:00:00+09:00");
  for (let i = 0; i < 50; i++) {
    const picked = pickRandomTimeInSlot(TODAY, slot, now);
    assert.ok(picked >= new Date("2026-09-02T07:00:00+09:00"));
    assert.ok(picked < new Date("2026-09-02T10:00:00+09:00"));
  }
});

test("pickRandomTimeInSlot: nowが枠の途中なら必ずnow以降・枠終了前の時刻になる", () => {
  const now = new Date("2026-09-02T09:00:00+09:00");
  for (let i = 0; i < 50; i++) {
    const picked = pickRandomTimeInSlot(TODAY, slot, now);
    assert.ok(picked >= now, `${picked.toISOString()} should be >= now`);
    assert.ok(picked < new Date("2026-09-02T10:00:00+09:00"));
  }
});

test("pickRandomTimeInSlot: nowを渡さなければ従来通りの挙動（後方互換）", () => {
  for (let i = 0; i < 50; i++) {
    const picked = pickRandomTimeInSlot(TODAY, slot);
    assert.ok(picked >= new Date("2026-09-02T07:00:00+09:00"));
    assert.ok(picked < new Date("2026-09-02T10:00:00+09:00"));
  }
});

// orderTextsForRoundRobin: 「脱サラ30年」実データ相当（3URL x 5文書=15件、
// createdAt昇順＝一括生成の保存順＝生成元URLごとにまとまった順）を、
// 生成元横断の転置順（URL1文書1→URL2文書1→URL3文書1→URL1文書2→…）に
// 並び替えられることを検証する。
function makeText(id, sourceExcerpt) {
  return { id, source_excerpt: sourceExcerpt };
}

test("orderTextsForRoundRobin: 生成元ごとにまとまった保存順を、生成元横断の転置順に並び替える", () => {
  const texts = [
    makeText("u1d1", "URL1"), makeText("u1d2", "URL1"), makeText("u1d3", "URL1"), makeText("u1d4", "URL1"), makeText("u1d5", "URL1"),
    makeText("u2d1", "URL2"), makeText("u2d2", "URL2"), makeText("u2d3", "URL2"), makeText("u2d4", "URL2"), makeText("u2d5", "URL2"),
    makeText("u3d1", "URL3"), makeText("u3d2", "URL3"), makeText("u3d3", "URL3"), makeText("u3d4", "URL3"), makeText("u3d5", "URL3"),
  ];
  const ordered = orderTextsForRoundRobin(texts).map((t) => t.id);
  assert.deepEqual(ordered, [
    "u1d1", "u2d1", "u3d1",
    "u1d2", "u2d2", "u3d2",
    "u1d3", "u2d3", "u3d3",
    "u1d4", "u2d4", "u3d4",
    "u1d5", "u2d5", "u3d5",
  ]);
});

test("orderTextsForRoundRobin: 生成元が1件のみ（Affinity移行ガイド相当）なら元の順序のまま", () => {
  const texts = [makeText("d1", "URL1"), makeText("d2", "URL1"), makeText("d3", "URL1")];
  const ordered = orderTextsForRoundRobin(texts).map((t) => t.id);
  assert.deepEqual(ordered, ["d1", "d2", "d3"]);
});

test("orderTextsForRoundRobin: 生成元ごとの文書数が異なる場合、尽きた生成元はその周回だけ抜ける", () => {
  const texts = [
    makeText("u1d1", "URL1"), makeText("u1d2", "URL1"),
    makeText("u2d1", "URL2"), makeText("u2d2", "URL2"), makeText("u2d3", "URL2"),
  ];
  const ordered = orderTextsForRoundRobin(texts).map((t) => t.id);
  assert.deepEqual(ordered, ["u1d1", "u2d1", "u1d2", "u2d2", "u2d3"]);
});

test("orderTextsForRoundRobin: source_excerptが無い（旧データ・単発作成）は1件ずつ独立したグループになる", () => {
  const texts = [
    makeText("u1d1", "URL1"), makeText("u1d2", "URL1"),
    { id: "solo1" }, { id: "solo2" },
  ];
  const ordered = orderTextsForRoundRobin(texts).map((t) => t.id);
  assert.deepEqual(ordered, ["u1d1", "solo1", "solo2", "u1d2"]);
});
