const crypto = require("crypto");

function decodeKey(value) {
  const key = Buffer.from(value || "", "base64");
  if (key.length !== 32) throw new Error("OAuth encryption key must be 32 bytes encoded as base64");
  return key;
}

function keyringFromEnv(env = process.env) {
  const currentVersion = Number(env.OAUTH_TOKEN_KEY_VERSION);
  if (!Number.isInteger(currentVersion) || currentVersion < 1) throw new Error("OAUTH_TOKEN_KEY_VERSION must be a positive integer");
  let rawKeys;
  try { rawKeys = JSON.parse(env.OAUTH_TOKEN_KEYS_JSON || "{}"); } catch { throw new Error("OAUTH_TOKEN_KEYS_JSON must be valid JSON"); }
  const keys = new Map(Object.entries(rawKeys).map(([version, key]) => [Number(version), decodeKey(key)]));
  if (!keys.has(currentVersion)) throw new Error(`OAuth encryption key version ${currentVersion} is missing`);
  return { currentVersion, keys };
}

function encryptSecret(plaintext, { currentVersion, keys }, context = "oauth-token") {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keys.get(currentVersion), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v${currentVersion}.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decryptSecret(encoded, { keys }, context = "oauth-token") {
  if (encoded == null) return null;
  const match = /^v(\d+)\.([^.]+)\.([^.]+)\.([^.]+)$/.exec(encoded);
  if (!match) throw new Error("invalid encrypted secret format");
  const version = Number(match[1]);
  const key = keys.get(version);
  if (!key) throw new Error(`OAuth encryption key version ${version} is unavailable`);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(match[2], "base64url"));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(match[3], "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(match[4], "base64url")), decipher.final()]).toString("utf8");
}

module.exports = { keyringFromEnv, encryptSecret, decryptSecret };
