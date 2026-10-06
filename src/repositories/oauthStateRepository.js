const crypto = require("crypto");
const { withTransaction } = require("../db/transaction");
const { encryptSecret, decryptSecret } = require("../security/tokenCrypto");

function stateHash(state) { return crypto.createHash("sha256").update(state).digest("hex"); }

function createOAuthStateRepository(db, { keyring, now = () => new Date().toISOString() } = {}) {
  if (!keyring) throw new Error("keyring is required");
  function create({ state, customerId, platform, codeVerifier = null, payload = null, expiresAt }) {
    const hash = stateHash(state);
    db.prepare(`INSERT INTO oauth_states(state_hash,customer_id,platform,code_verifier_ciphertext,payload_ciphertext,
      encryption_key_version,expires_at,created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(hash, customerId, platform,
        encryptSecret(codeVerifier, keyring, `oauth-state:${hash}:verifier`),
        encryptSecret(payload == null ? null : JSON.stringify(payload), keyring, `oauth-state:${hash}:payload`),
        keyring.currentVersion, expiresAt, now());
    return hash;
  }

  function consume(state, at = now()) {
    const hash = stateHash(state);
    return withTransaction(db, () => {
      const row = db.prepare(`UPDATE oauth_states SET consumed_at=? WHERE state_hash=? AND consumed_at IS NULL
        AND expires_at > ? RETURNING *`).get(at, hash, at);
      if (!row) return null;
      return {
        customerId: row.customer_id,
        platform: row.platform,
        codeVerifier: decryptSecret(row.code_verifier_ciphertext, keyring, `oauth-state:${hash}:verifier`),
        payload: row.payload_ciphertext ? JSON.parse(decryptSecret(row.payload_ciphertext, keyring, `oauth-state:${hash}:payload`)) : null,
      };
    });
  }
  return { create, consume };
}

module.exports = { stateHash, createOAuthStateRepository };
