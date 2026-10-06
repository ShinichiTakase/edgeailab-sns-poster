const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { contentHash } = require("./canonicalJson");
const { ENDPOINTS, executeReverse } = require("./reverseProductionWriter");

function bundle(overrides = {}) {
  return { microcms: Object.fromEntries(ENDPOINTS.map((name) => [name, overrides[name] || []])), json: overrides.json || {} };
}
function stub(initial, failAt = 0) {
  const data = structuredClone(initial); let writes = 0; let failed = false;
  return { data, get writes() { return writes; }, async listAll(name) { return structuredClone(data[name] || []); },
    async put(name, id, row) { writes++; if (failAt && writes === failAt && !failed) { failed = true; throw Object.assign(new Error("fixture failure"), { code: "FIXTURE_FAILURE" }); } const rows = data[name] ||= []; const at = rows.findIndex((x) => x.id === id); if (at < 0) rows.push(structuredClone(row)); else rows[at] = structuredClone(row); },
    async delete(name, id) { writes++; if (failAt && writes === failAt && !failed) { failed = true; throw Object.assign(new Error("fixture failure"), { code: "FIXTURE_FAILURE" }); } data[name] = (data[name] || []).filter((x) => x.id !== id); } };
}
function fixture() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reverse-writer-")); return { dir, json: path.join(dir, "json"), manifest: path.join(dir, "operations.json"), close() { fs.rmSync(dir, { recursive: true, force: true }); } }; }
function baselineManifest(value) { return { manifestHash: contentHash(value) }; }

test("reverse writer dry-run plans create/update/delete without writing or exposing values", async () => {
  const f = fixture();
  try {
    const before = bundle({ customers: [{ id: "update", name: "old" }, { id: "delete", name: "old" }], json: { "client_tokens.json": { secretValue: "not-in-manifest" } } });
    const target = bundle({ customers: [{ id: "update", name: "new" }, { id: "create", name: "new" }], json: { "client_tokens.json": { secretValue: "changed" } } });
    fs.mkdirSync(f.json); fs.writeFileSync(path.join(f.json, "client_tokens.json"), JSON.stringify(before.json["client_tokens.json"]));
    const client = stub(before.microcms);
    const result = await executeReverse({ client, baseline: before, baselineManifest: baselineManifest(before), target, currentJsonDirectory: f.json, operationManifestPath: f.manifest });
    assert.deepEqual(result.operations.filter((x) => x.endpoint === "customers").map((x) => x.operation).sort(), ["create", "delete", "update"]);
    assert.equal(client.writes, 0);
    const raw = fs.readFileSync(f.manifest, "utf8");
    assert.equal(raw.includes("not-in-manifest"), false); assert.equal(raw.includes("changed"), false);
  } finally { f.close(); }
});

test("reverse writer apply preserves IDs and duplicate execution is idempotent", async () => {
  const f = fixture();
  try {
    const before = bundle({ customers: [{ id: "u", value: 1 }, { id: "d", value: 1 }], json: { "state.json": { old: true } } });
    const target = bundle({ customers: [{ id: "u", value: 2 }, { id: "c", value: 3 }], json: { "state.json": { old: false } } });
    fs.mkdirSync(f.json); fs.writeFileSync(path.join(f.json, "state.json"), JSON.stringify(before.json["state.json"]));
    const client = stub(before.microcms);
    await executeReverse({ client, baseline: before, baselineManifest: baselineManifest(before), target, currentJsonDirectory: f.json, operationManifestPath: f.manifest, apply: true });
    assert.deepEqual(client.data.customers.map((x) => x.id).sort(), ["c", "u"]); assert.equal(client.writes, 3);
    await executeReverse({ client, baseline: before, baselineManifest: baselineManifest(before), target, currentJsonDirectory: f.json, operationManifestPath: f.manifest, apply: true });
    assert.equal(client.writes, 3);
  } finally { f.close(); }
});

test("reverse writer stops on source conflict before any write", async () => {
  const f = fixture();
  try {
    const before = bundle({ customers: [{ id: "u", value: 1 }] }); const target = bundle({ customers: [{ id: "u", value: 2 }] });
    const client = stub(bundle({ customers: [{ id: "u", value: 99 }] }).microcms);
    await assert.rejects(executeReverse({ client, baseline: before, baselineManifest: baselineManifest(before), target, currentJsonDirectory: f.json, operationManifestPath: f.manifest, apply: true }), /source conflict/);
    assert.equal(client.writes, 0);
  } finally { f.close(); }
});

test("partial failure records only an error code and retry completes remaining operations", async () => {
  const f = fixture();
  try {
    const before = bundle({ customers: [{ id: "a", value: 1 }, { id: "b", value: 1 }] });
    const target = bundle({ customers: [{ id: "a", value: 2 }, { id: "b", value: 2 }] });
    const client = stub(before.microcms, 2);
    await assert.rejects(executeReverse({ client, baseline: before, baselineManifest: baselineManifest(before), target, currentJsonDirectory: f.json, operationManifestPath: f.manifest, apply: true }), /fixture failure/);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.manifest)).failure, { code: "FIXTURE_FAILURE" });
    await executeReverse({ client, baseline: before, baselineManifest: baselineManifest(before), target, currentJsonDirectory: f.json, operationManifestPath: f.manifest, apply: true });
    assert.deepEqual(client.data.customers, target.microcms.customers);
  } finally { f.close(); }
});

test("baseline source hash is mandatory and must match", async () => {
  const f = fixture(); const before = bundle();
  try {
    await assert.rejects(executeReverse({ client: stub(before.microcms), baseline: before, baselineManifest: {}, target: before, currentJsonDirectory: f.json, operationManifestPath: f.manifest }), /required/);
    await assert.rejects(executeReverse({ client: stub(before.microcms), baseline: before, baselineManifest: { manifestHash: "wrong" }, target: before, currentJsonDirectory: f.json, operationManifestPath: f.manifest }), /mismatch/);
  } finally { f.close(); }
});
