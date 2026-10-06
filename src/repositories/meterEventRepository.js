function createMeterEventRepository(db, { now = () => new Date().toISOString() } = {}) {
  function ensure(event) {
    const timestamp = now();
    db.prepare(`INSERT INTO billing_meter_events(id,idempotency_key,customer_id,posting_log_id,scheduled_post_id,
      event_name,quantity,state,created_at,updated_at) VALUES (@id,@idempotencyKey,@customerId,@postingLogId,
      @scheduledPostId,@eventName,@quantity,'pending',@timestamp,@timestamp) ON CONFLICT(idempotency_key) DO NOTHING`)
      .run({ ...event, postingLogId: event.postingLogId || null, scheduledPostId: event.scheduledPostId || null, timestamp });
    return db.prepare("SELECT * FROM billing_meter_events WHERE idempotency_key=?").get(event.idempotencyKey);
  }

  function claim({ id, workerId, leaseExpiresAt, at = now() }) {
    if (!workerId || !leaseExpiresAt) throw new Error("workerId and leaseExpiresAt are required");
    return db.prepare(`UPDATE billing_meter_events SET state='processing',attempt_count=attempt_count+1,
      lease_owner=?,lease_expires_at=?,updated_at=?
      WHERE id=? AND state IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) RETURNING *`)
      .get(workerId, leaseExpiresAt, at, id, at) || null;
  }

  function finish(id, { state, stripeEventIdentifier = null, error = null, nextAttemptAt = null, at = now() }) {
    if (!["done", "ambiguous", "failed", "skipped"].includes(state)) throw new Error("invalid meter state");
    const result = db.prepare(`UPDATE billing_meter_events SET state=?,stripe_event_identifier=?,last_error=?,next_attempt_at=?,
      lease_owner=NULL,lease_expires_at=NULL,updated_at=?,completed_at=CASE WHEN ? IN ('done','skipped') THEN ? ELSE NULL END WHERE id=? AND state='processing'`)
      .run(state, stripeEventIdentifier, error, nextAttemptAt, at, state, at, id);
    return result.changes === 1;
  }
  return { ensure, claim, finish };
}

module.exports = { createMeterEventRepository };
