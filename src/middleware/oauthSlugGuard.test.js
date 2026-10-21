const test = require("node:test");
const assert = require("node:assert/strict");
const { requireMatchingSlugParam } = require("./oauthSlugGuard");

function run(query, customer) {
  const out = { next: false };
  const res = { status(c) { out.status = c; return this; }, send(b) { out.body = b; return this; } };
  requireMatchingSlugParam("x")({ query, customer }, res, () => { out.next = true; });
  return out;
}
const customer = { id: "idA", slug: "slug-a" };

test("no ?slug= passes through", () => assert.equal(run({}, customer).next, true));
test("matching slug or id passes", () => {
  assert.equal(run({ slug: "slug-a" }, customer).next, true);
  assert.equal(run({ slug: "idA" }, customer).next, true);
});
test("mismatch / empty / array is blocked with message", () => {
  for (const slug of ["slug-b", "", ["slug-a"]]) {
    const r = run({ slug }, customer);
    assert.equal(r.next, false);
    assert.equal(r.status, 403);
    assert.match(r.body, /別の契約用/);
  }
});
