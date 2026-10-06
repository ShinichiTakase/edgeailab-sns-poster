const { withTransaction } = require("../db/transaction");

const EFFECT_TYPES = Object.freeze(["posting_log", "trial_post_count", "stripe_meter", "email", "notification"]);

function createEffectRepository(db, { now = () => new Date().toISOString() } = {}) {
  function ensure({ scheduledPostId, effectType, idempotencyKey }) {
    if (!EFFECT_TYPES.includes(effectType)) throw new Error("invalid effect type");
    const timestamp = now();
    db.prepare(`INSERT INTO scheduled_post_effects(scheduled_post_id,effect_type,idempotency_key,state,created_at,updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?) ON CONFLICT(scheduled_post_id,effect_type) DO NOTHING`)
      .run(scheduledPostId, effectType, idempotencyKey, timestamp, timestamp);
    return db.prepare("SELECT * FROM scheduled_post_effects WHERE scheduled_post_id=? AND effect_type=?")
      .get(scheduledPostId, effectType);
  }

  function claim({ effectId, workerId, leaseExpiresAt, at = now() }) {
    if (!workerId || !leaseExpiresAt) throw new Error("workerId and leaseExpiresAt are required");
    return db.prepare(`UPDATE scheduled_post_effects SET state='processing', attempt_count=attempt_count+1,
      lease_owner=?, lease_expires_at=?, updated_at=?
      WHERE id=? AND state IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) RETURNING *`)
      .get(workerId, leaseExpiresAt, at, effectId, at) || null;
  }

  function finish(effectId, { state, externalReference = null, errorCode = null, errorMessage = null, nextAttemptAt = null, at = now() }) {
    if (!["done", "ambiguous", "failed", "skipped"].includes(state)) throw new Error("invalid effect state");
    const result = db.prepare(`UPDATE scheduled_post_effects SET state=?, external_reference=?, last_error_code=?,
      last_error_message=?, next_attempt_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=?, completed_at=CASE WHEN ? IN ('done','skipped') THEN ? ELSE NULL END
      WHERE id=? AND state='processing'`).run(state, externalReference, errorCode, errorMessage, nextAttemptAt, at, state, at, effectId);
    return result.changes === 1;
  }

  function ensureAll(scheduledPostId) {
    return withTransaction(db, () => EFFECT_TYPES.map((type) => ensure({
      scheduledPostId, effectType: type, idempotencyKey: `scheduled-post:${scheduledPostId}:${type}`,
    })));
  }

  function listForPost(scheduledPostId) {
    return db.prepare("SELECT * FROM scheduled_post_effects WHERE scheduled_post_id=? ORDER BY id").all(scheduledPostId);
  }

  function recoverExpiredLeases({ expiredBefore = now(), externalTypes = ["stripe_meter", "email"] } = {}) {
    return withTransaction(db, () => {
      const placeholders = externalTypes.map(() => "?").join(",") || "''";
      const ambiguous = db.prepare(`UPDATE scheduled_post_effects SET state='ambiguous',lease_owner=NULL,lease_expires_at=NULL,
        last_error_code='lease_expired_external_effect',updated_at=? WHERE state='processing' AND lease_expires_at<?
        AND effect_type IN (${placeholders})`).run(expiredBefore, expiredBefore, ...externalTypes).changes;
      const retryable = db.prepare(`UPDATE scheduled_post_effects SET state='pending',lease_owner=NULL,lease_expires_at=NULL,
        last_error_code='lease_expired_local_effect',updated_at=? WHERE state='processing' AND lease_expires_at<?
        AND effect_type NOT IN (${placeholders})`).run(expiredBefore, expiredBefore, ...externalTypes).changes;
      return { ambiguous, retryable };
    });
  }

  function runLocal(effectId, { workerId, leaseExpiresAt, at = now() }, callback) {
    return withTransaction(db, () => {
      const effect = claim({ effectId, workerId, leaseExpiresAt, at });
      if (!effect) return false;
      const result = callback(effect);
      if (result && typeof result.then === "function") throw new Error("local effect callback must be synchronous");
      finish(effectId, { state: result?.state || "done", externalReference: result?.externalReference || null, at: now() });
      return true;
    });
  }

  return { ensure, ensureAll, listForPost, claim, finish, runLocal, recoverExpiredLeases };
}

module.exports = { EFFECT_TYPES, createEffectRepository };
