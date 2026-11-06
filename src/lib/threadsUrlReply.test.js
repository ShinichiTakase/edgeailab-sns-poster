const test = require("node:test");
const assert = require("node:assert/strict");
const { postToPlatform } = require("./scheduledPostExecutor");

function stubFetch(calls) {
  let n = 0;
  return async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method });
    n += 1;
    // 1: 本文のコンテナ, 2: 本文の公開, 3: 返信のコンテナ, 4: 返信の公開
    return { ok: true, json: async () => ({ id: `id${n}` }) };
  };
}
const entry = { user_id: "u1", access_token: "T" };
const logger = { logError() {} };

test("flag on: url is removed from the post and sent as a reply", async () => {
  const saved = global.fetch, savedEnv = process.env.THREADS_URL_REPLY_ENABLED;
  const calls = [];
  global.fetch = stubFetch(calls);
  process.env.THREADS_URL_REPLY_ENABLED = "1";
  try {
    const r = await postToPlatform("threads", entry, "新作です\nhttps://a.example/p", undefined, undefined, null, logger, {});
    assert.equal(r.id, "id2");
    assert.equal(calls.length, 4);
    const main = decodeURIComponent(calls[0].url);
    assert.ok(!main.includes("https://a.example"), "本文にURLが残っている");
    assert.match(main, /text=新作です/);
    const reply = decodeURIComponent(calls[2].url);
    assert.match(reply, /reply_to_id=id2/);
    assert.match(reply, /text=詳細は、https:\/\/a\.example\/pをご覧ください/);
  } finally { global.fetch = saved; if (savedEnv === undefined) delete process.env.THREADS_URL_REPLY_ENABLED; else process.env.THREADS_URL_REPLY_ENABLED = savedEnv; }
});

test("flag off: the post is unchanged and no reply is sent", async () => {
  const saved = global.fetch, savedEnv = process.env.THREADS_URL_REPLY_ENABLED;
  const calls = [];
  global.fetch = stubFetch(calls);
  delete process.env.THREADS_URL_REPLY_ENABLED;
  try {
    await postToPlatform("threads", entry, "新作です\nhttps://a.example/p", undefined, undefined, null, logger, {});
    assert.equal(calls.length, 2);
    assert.ok(decodeURIComponent(calls[0].url).includes("https://a.example/p"));
  } finally { global.fetch = saved; if (savedEnv !== undefined) process.env.THREADS_URL_REPLY_ENABLED = savedEnv; }
});

test("flag on: a failed reply does not fail the post", async () => {
  const saved = global.fetch, savedEnv = process.env.THREADS_URL_REPLY_ENABLED;
  let n = 0; const errors = [];
  global.fetch = async () => { n += 1; return n <= 2 ? { ok: true, json: async () => ({ id: `id${n}` }) } : { ok: false, status: 403, json: async () => ({ error: { code: 10 } }) }; };
  process.env.THREADS_URL_REPLY_ENABLED = "1";
  try {
    const r = await postToPlatform("threads", entry, "新作です\nhttps://a.example/p", undefined, undefined, null, { logError: (m) => errors.push(m) }, {});
    assert.equal(r.id, "id2");
    assert.equal(errors.length, 1);
  } finally { global.fetch = saved; if (savedEnv === undefined) delete process.env.THREADS_URL_REPLY_ENABLED; else process.env.THREADS_URL_REPLY_ENABLED = savedEnv; }
});
