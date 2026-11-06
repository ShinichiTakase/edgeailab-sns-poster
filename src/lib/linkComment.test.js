const test = require("node:test");
const assert = require("node:assert");
const lc = require("./linkComment");

const okFetch = (calls, body = { id: "c1" }) => async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => body }; };

test("buildLinkCommentText", () => {
  assert.strictEqual(lc.buildLinkCommentText("https://a.example/x"), "詳細は、https://a.example/xをご覧ください");
});

test("isValidLinkUrl rejects non-http and overlong", () => {
  assert.ok(lc.isValidLinkUrl("https://a.example/x"));
  assert.ok(!lc.isValidLinkUrl("javascript:alert(1)"));
  assert.ok(!lc.isValidLinkUrl("https://a.example/ x"));
  assert.ok(!lc.isValidLinkUrl("https://a.example/" + "a".repeat(1100)));
  assert.ok(!lc.isValidLinkUrl(""));
});

test("splitUrlFromThreadsText removes the url and tidies blank lines", () => {
  const r = lc.splitUrlFromThreadsText("新作です。\n#tag\nhttps://a.example/p?x=1");
  assert.strictEqual(r.url, "https://a.example/p?x=1");
  assert.strictEqual(r.text, "新作です。\n#tag");
});

test("splitUrlFromThreadsText keeps text when only a url", () => {
  const r = lc.splitUrlFromThreadsText("https://a.example/p");
  assert.strictEqual(r.url, null);
  assert.strictEqual(r.text, "https://a.example/p");
});

test("splitUrlFromThreadsText without url", () => {
  assert.deepStrictEqual(lc.splitUrlFromThreadsText("こんにちは"), { text: "こんにちは", url: null });
});

test("instagram comment posts to /{media}/comments", async () => {
  const calls = [];
  await lc.commentOnInstagramMedia({ accessToken: "T" }, "123", "https://a.example/", okFetch(calls));
  assert.match(calls[0].url, /graph\.instagram\.com\/v26\.0\/123\/comments$/);
  assert.strictEqual(JSON.parse(calls[0].opts.body).message, "詳細は、https://a.example/をご覧ください");
});

test("facebook comment uses bearer token", async () => {
  const calls = [];
  await lc.commentOnFacebookVideo({ pageAccessToken: "P" }, "55", "https://a.example/", okFetch(calls));
  assert.match(calls[0].url, /graph\.facebook\.com\/v26\.0\/55\/comments$/);
  assert.strictEqual(calls[0].opts.headers.Authorization, "Bearer P");
});

test("threads reply creates then publishes", async () => {
  const calls = [];
  await lc.replyOnThreads({ userId: "u1", accessToken: "T" }, "99", "https://a.example/", okFetch(calls));
  assert.strictEqual(calls.length, 2);
  assert.match(calls[0].url, /\/u1\/threads\?.*reply_to_id=99/);
  assert.match(calls[1].url, /\/u1\/threads_publish\?.*creation_id=c1/);
});

test("api error becomes an error without body text", async () => {
  const f = async () => ({ ok: false, status: 403, json: async () => ({ error: { code: 200, message: "secret" } }) });
  await assert.rejects(lc.commentOnFacebookVideo({ pageAccessToken: "P" }, "1", "https://a.example/", f), (e) => e.code === "graph_200" && !/secret/.test(e.message));
});

test("no url or no id means no call", async () => {
  const calls = [];
  assert.strictEqual(await lc.commentOnInstagramMedia({ accessToken: "T" }, "1", "", okFetch(calls)), null);
  assert.strictEqual(await lc.commentOnInstagramMedia({ accessToken: "T" }, "", "https://a.example/", okFetch(calls)), null);
  assert.strictEqual(calls.length, 0);
});

test("threads url reply is off unless env flag is 1", () => {
  assert.ok(!lc.isThreadsUrlReplyEnabled({}));
  assert.ok(lc.isThreadsUrlReplyEnabled({ THREADS_URL_REPLY_ENABLED: "1" }));
});
