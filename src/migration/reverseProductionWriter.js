const fs = require("fs");
const path = require("path");
const { canonicalJson, contentHash } = require("./canonicalJson");

const ENDPOINTS = ["customers", "post_schedules", "schedule_texts", "scheduled_posts", "posting_logs"];

function stableRow(row) { const { createdAt, updatedAt, publishedAt, revisedAt, ...stable } = row; return stable; }
function rowHash(row) { return row && contentHash(stableRow(row)); }
function hashRows(rows) { return contentHash([...rows].sort((a, b) => String(a.id).localeCompare(String(b.id))).map(stableRow)); }
function summary(rows) { return { count: rows.length, idSetHash: contentHash(rows.map((row) => row.id).sort()), contentHash: hashRows(rows) }; }
function safeError(error) { return String(error?.code || error?.name || "write_failed").replace(/[^A-Za-z0-9_.-]/g, "_"); }

function validateBaseline(baseline, baselineManifest) {
  if (!baselineManifest?.manifestHash) throw new Error("baseline source hash is required");
  if (baselineManifest.microcms || baselineManifest.json) {
    for (const endpoint of ENDPOINTS) if (baselineManifest.microcms?.[endpoint]?.contentHash !== contentHash(baseline.microcms?.[endpoint] || [])) throw new Error(`baseline source hash mismatch ${endpoint}`);
    for (const [name, info] of Object.entries(baselineManifest.json || {})) if (info.present && info.contentHash !== contentHash(baseline.json?.[name])) throw new Error(`baseline source hash mismatch json/${name}`);
  } else if (contentHash(baseline) !== baselineManifest.manifestHash) throw new Error("baseline source hash mismatch");
}

function planRows(endpoint, baselineRows, currentRows, targetRows) {
  const baseline = new Map(baselineRows.map((row) => [String(row.id), row]));
  const current = new Map(currentRows.map((row) => [String(row.id), row]));
  const target = new Map(targetRows.map((row) => [String(row.id), row]));
  const ids = new Set([...baseline.keys(), ...current.keys(), ...target.keys()]);
  const operations = [];
  for (const id of [...ids].sort()) {
    const before = baseline.get(id), now = current.get(id), after = target.get(id);
    const beforeHash = rowHash(before), currentHash = rowHash(now), afterHash = rowHash(after);
    if (!before && after) {
      if (!now) operations.push({ endpoint, id, operation: "create", expectedHash: null, targetHash: afterHash, status: "pending" });
      else if (currentHash === afterHash) operations.push({ endpoint, id, operation: "create", expectedHash: null, targetHash: afterHash, status: "already_applied" });
      else throw new Error(`source conflict ${endpoint}/${id}`);
    } else if (before && !after) {
      if (!now) operations.push({ endpoint, id, operation: "delete", expectedHash: beforeHash, targetHash: null, status: "already_applied" });
      else if (currentHash === beforeHash) operations.push({ endpoint, id, operation: "delete", expectedHash: beforeHash, targetHash: null, status: "pending" });
      else throw new Error(`source conflict ${endpoint}/${id}`);
    } else if (before && after && beforeHash !== afterHash) {
      if (currentHash === beforeHash) operations.push({ endpoint, id, operation: "update", expectedHash: beforeHash, targetHash: afterHash, status: "pending" });
      else if (currentHash === afterHash) operations.push({ endpoint, id, operation: "update", expectedHash: beforeHash, targetHash: afterHash, status: "already_applied" });
      else throw new Error(`source conflict ${endpoint}/${id}`);
    } else if (before && after && currentHash !== beforeHash) throw new Error(`source conflict ${endpoint}/${id}`);
  }
  return operations;
}

function atomicWriteJson(filename, value, io = fs) {
  const directory = path.dirname(filename);
  io.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = `${filename}.tmp-${process.pid}`;
  const fd = io.openSync(temp, "wx", 0o600);
  try { io.writeFileSync(fd, `${canonicalJson(value)}\n`); io.fsyncSync(fd); }
  finally { io.closeSync(fd); }
  io.renameSync(temp, filename);
  const dirFd = io.openSync(directory, "r");
  try { io.fsyncSync(dirFd); } finally { io.closeSync(dirFd); }
}

async function executeReverse({ client, baseline, baselineManifest, currentJsonDirectory, target, operationManifestPath, apply = false, io = fs }) {
  validateBaseline(baseline, baselineManifest);
  const current = { microcms: {}, json: {} };
  const manifest = { version: 1, mode: apply ? "apply" : "dry-run", baselineHash: baselineManifest.manifestHash,
    startedAt: new Date().toISOString(), endpoints: {}, json: {}, operations: [], confidentialValuesIncluded: false };

  for (const endpoint of ENDPOINTS) {
    current.microcms[endpoint] = await client.listAll(endpoint);
    const operations = planRows(endpoint, baseline.microcms[endpoint] || [], current.microcms[endpoint], target.microcms[endpoint] || []);
    manifest.endpoints[endpoint] = { before: summary(current.microcms[endpoint]), target: summary(target.microcms[endpoint] || []) };
    manifest.operations.push(...operations);
  }

  for (const [name, targetValue] of Object.entries(target.json || {})) {
    const filename = path.join(currentJsonDirectory, name);
    const currentValue = io.existsSync(filename) ? JSON.parse(io.readFileSync(filename, "utf8")) : null;
    const baselineValue = baseline.json?.[name] ?? null;
    const beforeHash = currentValue == null ? null : contentHash(currentValue);
    const baselineHash = baselineValue == null ? null : contentHash(baselineValue);
    const targetHash = contentHash(targetValue);
    if (beforeHash !== baselineHash && beforeHash !== targetHash) throw new Error(`source conflict json/${name}`);
    const status = beforeHash === targetHash ? "already_applied" : "pending";
    manifest.json[name] = { beforeHash, targetHash, status };
    manifest.operations.push({ endpoint: "legacy_json", id: name, operation: currentValue == null ? "create" : "update", expectedHash: baselineHash, targetHash, status });
  }
  atomicWriteJson(operationManifestPath, manifest, io);
  if (!apply) return manifest;

  try {
    for (const operation of manifest.operations.filter((item) => item.endpoint !== "legacy_json" && item.status === "pending")) {
      const targetRow = (target.microcms[operation.endpoint] || []).find((row) => String(row.id) === operation.id);
      if (operation.operation === "delete") await client.delete(operation.endpoint, operation.id);
      else await client.put(operation.endpoint, operation.id, targetRow);
      operation.status = "applied";
      atomicWriteJson(operationManifestPath, manifest, io);
    }
    for (const [name, info] of Object.entries(manifest.json)) if (info.status === "pending") {
      atomicWriteJson(path.join(currentJsonDirectory, name), target.json[name], io);
      info.status = "applied";
      manifest.operations.find((item) => item.endpoint === "legacy_json" && item.id === name).status = "applied";
      atomicWriteJson(operationManifestPath, manifest, io);
    }
  } catch (error) {
    manifest.failure = { code: safeError(error) };
    atomicWriteJson(operationManifestPath, manifest, io);
    throw error;
  }

  for (const endpoint of ENDPOINTS) {
    const rows = await client.listAll(endpoint);
    const expected = summary(target.microcms[endpoint] || []), actual = summary(rows);
    manifest.endpoints[endpoint].after = actual;
    if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`post-apply verification failed ${endpoint}`);
  }
  for (const [name, value] of Object.entries(target.json || {})) {
    const actual = JSON.parse(io.readFileSync(path.join(currentJsonDirectory, name), "utf8"));
    if (contentHash(actual) !== contentHash(value)) throw new Error(`post-apply verification failed json/${name}`);
  }
  manifest.completedAt = new Date().toISOString();
  atomicWriteJson(operationManifestPath, manifest, io);
  return manifest;
}

module.exports = { ENDPOINTS, summary, planRows, atomicWriteJson, executeReverse, validateBaseline };
