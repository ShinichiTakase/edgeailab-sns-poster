const test = require("node:test");
const assert = require("node:assert/strict");
const { isSafeReturnTo } = require("./returnTo");
const { redirectIfUnauthenticated } = require("../middleware/redirectIfUnauthenticated");
const { signSession, COOKIE_NAME } = require("./jwt");

test("allowed OAuth start paths (with ?slug=) are accepted", () => {
  for (const v of ["/oauth/x/authorize", "/oauth/x/authorize?slug=0be38f91-04b4-493a-92f5-9319f3b53d3b", "/oauth/threads/start", "/oauth/instagram/start", "/oauth/linkedin/start", "/oauth/facebook/start?slug=abc"]) {
    assert.equal(isSafeReturnTo(v), true, v);
  }
});

test("disallowed / open-redirect values are rejected", () => {
  for (const v of ["//evil.example/oauth/x/authorize", "/\\evil.example", "/oauth/x/authorize\\..", "https://evil.example/oauth/x/authorize", "oauth/x/authorize", "", undefined, null, 5,
    "/dashboard.html", "/api/auth/logout", "/oauth/x/callback", "/oauth/x/authorize/../../x", "/oauth/x/authorize?slug=a//b", "/oauth/x/authorize#frag", "/oauth/x/authorize?next=//evil", "/oauth/x/authorize\n", "/oauth/google/start"]) {
    assert.equal(isSafeReturnTo(v), false, String(v));
  }
});

function call(req) {
  const out = { next: false };
  redirectIfUnauthenticated({ headers: {}, ...req }, { redirect: (u) => { out.redirect = u; } }, () => { out.next = true; });
  return out;
}

test("unauthenticated request is redirected to login with encoded returnTo", () => {
  const url = "/oauth/x/authorize?slug=slug-a";
  assert.equal(call({ originalUrl: url }).redirect, `/login.html?returnTo=${encodeURIComponent(url)}`);
  assert.equal(call({ originalUrl: url, headers: { cookie: `${COOKIE_NAME}=garbage` } }).redirect, `/login.html?returnTo=${encodeURIComponent(url)}`);
});

test("unauthenticated with an unsafe originalUrl redirects to plain login", () => {
  assert.equal(call({ originalUrl: "/oauth/x/authorize?x=//evil" }).redirect, "/login.html");
});

test("valid session passes through", () => {
  const token = signSession({ id: "c1" }, { userId: "u1", email: "a@example.test", sessionVersion: 0 });
  const out = call({ originalUrl: "/oauth/x/authorize", headers: { cookie: `${COOKIE_NAME}=${token}` } });
  assert.equal(out.next, true);
  assert.equal(out.redirect, undefined);
});

// login.html（静的サイト側、別リポジトリ）のクライアント側判定がサーバー側と一致していること。
// リポジトリ外に無い環境（worktree等）ではスキップする。
test("login.html isSafeReturnTo matches the server-side validator", { skip: !require("fs").existsSync(require("path").join(__dirname, "..", "..", "..", "login.html")) }, () => {
  const html = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "..", "login.html"), "utf-8");
  const m = html.match(/function isSafeReturnTo\(v\) \{[\s\S]*?\n    \}\n/);
  assert.ok(m, "helper found");
  const client = new Function(`${m[0]}; return isSafeReturnTo;`)();
  for (const v of ["/oauth/x/authorize?slug=abc", "/oauth/threads/start", "//evil.example", "/\\evil", "/dashboard.html", "/oauth/x/callback", "/oauth/x/authorize?slug=a//b", "", null, "/oauth/x/authorize#f"]) {
    assert.equal(client(v), isSafeReturnTo(v), String(v));
  }
});
