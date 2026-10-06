const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const { exportSources } = require("./exportSources");

async function main() {
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex < 0 || !process.argv[outputIndex + 1]) throw new Error("--output is required");
  const serviceDomain = process.env.MICROCMS_SERVICE_DOMAIN;
  const apiKey = process.env.MICROCMS_API_KEY;
  if (!serviceDomain || !apiKey) throw new Error("microCMS environment is unavailable");
  const manifest = await exportSources({ outputDirectory: process.argv[outputIndex + 1],
    jsonDirectory: path.join(__dirname, "..", "..", "json"), serviceDomain, apiKey });
  const counts = Object.fromEntries(Object.entries(manifest.microcms).map(([name, data]) => [name, data.count]));
  console.log(JSON.stringify({ exportedAt: manifest.exportedAt, counts, jsonFiles: Object.keys(manifest.json) }));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
