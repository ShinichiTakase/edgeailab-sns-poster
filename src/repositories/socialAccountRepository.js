const { encryptSecret, decryptSecret } = require("../security/tokenCrypto");

function createSocialAccountRepository(db, { keyring, now = () => new Date().toISOString() } = {}) {
  if (!keyring) throw new Error("keyring is required");
  function upsert(account) {
    const timestamp = now();
    const context = `${account.platform}:${account.externalAccountId}`;
    db.prepare(`INSERT INTO social_accounts(customer_id,platform,external_account_id,username,access_token_ciphertext,
      refresh_token_ciphertext,encryption_key_version,token_expires_at,metadata_json,connected_at,updated_at)
      VALUES (@customerId,@platform,@externalAccountId,@username,@accessToken,@refreshToken,@keyVersion,@tokenExpiresAt,
      @metadataJson,@timestamp,@timestamp) ON CONFLICT(platform,external_account_id) DO UPDATE SET
      customer_id=excluded.customer_id,username=excluded.username,access_token_ciphertext=excluded.access_token_ciphertext,
      refresh_token_ciphertext=excluded.refresh_token_ciphertext,encryption_key_version=excluded.encryption_key_version,
      token_expires_at=excluded.token_expires_at,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at,disconnected_at=NULL`)
      .run({ customerId: account.customerId, platform: account.platform, externalAccountId: account.externalAccountId,
        username: account.username || "", accessToken: encryptSecret(account.accessToken, keyring, `${context}:access`),
        refreshToken: encryptSecret(account.refreshToken, keyring, `${context}:refresh`), keyVersion: keyring.currentVersion,
        tokenExpiresAt: account.tokenExpiresAt || null, metadataJson: JSON.stringify(account.metadata || {}), timestamp });
    return get(account.platform, account.externalAccountId);
  }

  function get(platform, externalAccountId) {
    const row = db.prepare("SELECT * FROM social_accounts WHERE platform=? AND external_account_id=?").get(platform, externalAccountId);
    if (!row) return null;
    const context = `${platform}:${externalAccountId}`;
    return { ...row,
      accessToken: decryptSecret(row.access_token_ciphertext, keyring, `${context}:access`),
      refreshToken: decryptSecret(row.refresh_token_ciphertext, keyring, `${context}:refresh`),
      metadata: JSON.parse(row.metadata_json),
    };
  }
  return { upsert, get };
}

module.exports = { createSocialAccountRepository };
