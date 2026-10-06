const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const { executeReverse } = require("./reverseProductionWriter");
const { createMicroCmsProductionClient } = require("./microCmsProductionClient");

function parseArgs(argv) {
  const result = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") result.apply = true;
    else if (argv[i].startsWith("--")) result[argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  for (const name of ["baseline", "baselineManifest", "target", "jsonDirectory", "operationManifest"]) if (!result[name]) throw new Error(`--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const read = (filename) => JSON.parse(fs.readFileSync(path.resolve(filename), "utf8"));
  const client = createMicroCmsProductionClient({ serviceDomain: process.env.MICROCMS_SERVICE_DOMAIN, apiKey: process.env.MICROCMS_API_KEY });
  const result = await executeReverse({ client, baseline: read(args.baseline), baselineManifest: read(args.baselineManifest),
    target: read(args.target), currentJsonDirectory: path.resolve(args.jsonDirectory), operationManifestPath: path.resolve(args.operationManifest), apply: args.apply });
  console.info(`[reverse-production] mode=${result.mode} operations=${result.operations.length} manifest=${path.resolve(args.operationManifest)}`);
}

if (require.main === module) main().catch((error) => { console.error(`[reverse-production] failed code=${error.code || error.name || "ERROR"}`); process.exit(1); });
module.exports = { parseArgs, main };
