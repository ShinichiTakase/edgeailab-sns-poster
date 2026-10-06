const crypto = require("crypto");

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function contentHash(value) { return sha256(canonicalJson(value)); }

module.exports = { canonicalize, canonicalJson, sha256, contentHash };
