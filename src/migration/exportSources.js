const fs = require("fs");
const path = require("path");
const { contentHash, sha256 } = require("./canonicalJson");

const MICROCMS_ENDPOINTS = Object.freeze(["customers", "post_schedules", "schedule_texts", "scheduled_posts", "posting_logs"]);
const JSON_SOURCES = Object.freeze([
  "client_tokens.json", "sns_history.json", "scheduled_post_retries.json", "posting_log_origins.json",
  "announcements.json", "announcement_reads.json", "x_surcharge_current.json", "x_surcharge_reservation.json",
  "admin_stats_last_month.json", "admin_stats_this_month.json",
]);

function secureWrite(filename, value) {
  fs.writeFileSync(filename, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function fetchAllMicrocms(endpoint, { serviceDomain, apiKey, fetchImpl = fetch }) {
  if (!MICROCMS_ENDPOINTS.includes(endpoint)) throw new Error(`unsupported endpoint: ${endpoint}`);
  const rows = [];
  for (let offset = 0;; offset += 100) {
    const url = `https://${serviceDomain}.microcms.io/api/v1/${endpoint}?limit=100&offset=${offset}`;
    const response = await fetchImpl(url, { method: "GET", headers: { "X-MICROCMS-API-KEY": apiKey } });
    if (!response.ok) throw new Error(`microCMS GET ${endpoint} failed with status ${response.status}`);
    const body = await response.json();
    const page = Array.isArray(body.contents) ? body.contents : [];
    rows.push(...page);
    if (page.length < 100) break;
  }
  return rows;
}

async function exportSources({ outputDirectory, jsonDirectory, serviceDomain, apiKey, fetchImpl = fetch, now = () => new Date().toISOString() }) {
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(outputDirectory, 0o700);
  const manifest = { version: 1, exportedAt: now(), microcms: {}, json: {} };
  for (const endpoint of MICROCMS_ENDPOINTS) {
    const rows = await fetchAllMicrocms(endpoint, { serviceDomain, apiKey, fetchImpl });
    const filename = `${endpoint}.json`;
    secureWrite(path.join(outputDirectory, filename), `${JSON.stringify(rows)}\n`);
    const ids = rows.map((row) => String(row.id)).sort();
    manifest.microcms[endpoint] = { file: filename, count: rows.length, idSetHash: contentHash(ids), contentHash: contentHash(rows) };
  }
  for (const name of JSON_SOURCES) {
    const source = path.join(jsonDirectory, name);
    if (!fs.existsSync(source)) {
      manifest.json[name] = { present: false, count: 0, contentHash: null };
      continue;
    }
    const raw = fs.readFileSync(source, "utf8");
    const value = raw.trim() ? JSON.parse(raw) : null;
    secureWrite(path.join(outputDirectory, name), raw);
    const count = Array.isArray(value) ? value.length : value && typeof value === "object" ? Object.keys(value).length : 0;
    manifest.json[name] = { present: true, file: name, count, contentHash: sha256(raw) };
  }
  const withoutHash = JSON.stringify(manifest);
  manifest.manifestHash = sha256(withoutHash);
  secureWrite(path.join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

module.exports = { MICROCMS_ENDPOINTS, JSON_SOURCES, fetchAllMicrocms, exportSources };
