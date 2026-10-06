const crypto = require("crypto");
const { withTransaction } = require("../db/transaction");

function createScheduledPostJobRepository(db, { now = () => new Date().toISOString(), uuid = () => crypto.randomUUID() } = {}) {
  function claimNext({ workerId, leaseExpiresAt, dueAt = now() }) {
    if (!workerId || !leaseExpiresAt) throw new Error("workerId and leaseExpiresAt are required");
    return withTransaction(db, () => {
      const attemptId = uuid();
      const timestamp = now();
      const job = db.prepare(`UPDATE scheduled_post_jobs SET
          state='processing', current_attempt_id=@attemptId, lease_owner=@workerId, lease_expires_at=@leaseExpiresAt,
          attempt_count=attempt_count+1, updated_at=@timestamp, version=version+1,
          last_error_code=NULL, last_error_message=NULL
        WHERE scheduled_post_id = (
          SELECT j.scheduled_post_id FROM scheduled_post_jobs j
          JOIN scheduled_posts p ON p.id=j.scheduled_post_id
          WHERE (j.state='pending' OR (
              j.state='failed' AND j.next_attempt_at IS NOT NULL AND j.next_attempt_at <= @dueAt
            ))
            AND p.scheduled_at <= @dueAt AND p.lifecycle_state='scheduled'
            AND p.approval_state IN ('none','approved')
          ORDER BY p.scheduled_at, j.scheduled_post_id LIMIT 1
        ) AND state IN ('pending','failed')
        RETURNING *`).get({ attemptId, workerId, leaseExpiresAt, timestamp, dueAt });
      if (!job) return null;
      db.prepare(`INSERT INTO scheduled_post_attempts(id, scheduled_post_id, attempt_no, worker_id, started_at)
                  VALUES (?, ?, ?, ?, ?)`).run(attemptId, job.scheduled_post_id, job.attempt_count, workerId, timestamp);
      return job;
    });
  }

  function markRequestStarted({ scheduledPostId, workerId, attemptId, at = now() }) {
    const result = db.prepare(`UPDATE scheduled_post_jobs SET request_started_at=?, updated_at=?, version=version+1
      WHERE scheduled_post_id=? AND state='processing' AND lease_owner=? AND current_attempt_id=? AND request_started_at IS NULL`)
      .run(at, at, scheduledPostId, workerId, attemptId);
    if (result.changes !== 1) throw new Error("job lease is not owned by this attempt");
    db.prepare("UPDATE scheduled_post_attempts SET request_started_at=? WHERE id=? AND scheduled_post_id=?")
      .run(at, attemptId, scheduledPostId);
  }

  function recordExternalContainer({ scheduledPostId, workerId, attemptId, externalContainerId, at = now() }) {
    const result = db.prepare(`UPDATE scheduled_post_jobs SET external_container_id=?,updated_at=?,version=version+1
      WHERE scheduled_post_id=? AND state='processing' AND lease_owner=? AND current_attempt_id=?`)
      .run(externalContainerId, at, scheduledPostId, workerId, attemptId);
    if (result.changes !== 1) throw new Error("job lease is not owned by this attempt");
    db.prepare("UPDATE scheduled_post_attempts SET external_container_id=? WHERE id=?").run(externalContainerId, attemptId);
  }

  function get(scheduledPostId) {
    return db.prepare("SELECT * FROM scheduled_post_jobs WHERE scheduled_post_id=?").get(scheduledPostId) || null;
  }

  function finish({ scheduledPostId, workerId, attemptId, state, externalPostId = null, externalContainerId = null,
    errorCode = null, errorMessage = null, nextAttemptAt = null, at = now() }) {
    if (!["sent", "failed", "ambiguous"].includes(state)) throw new Error("invalid finish state");
    return withTransaction(db, () => {
      const result = db.prepare(`UPDATE scheduled_post_jobs SET state=@state, external_post_id=@externalPostId,
        external_container_id=COALESCE(@externalContainerId, external_container_id), last_error_code=@errorCode,
        last_error_message=@errorMessage, next_attempt_at=@nextAttemptAt, lease_owner=NULL, lease_expires_at=NULL,
        updated_at=@at, version=version+1 WHERE scheduled_post_id=@scheduledPostId AND state='processing'
        AND lease_owner=@workerId AND current_attempt_id=@attemptId`).run({ scheduledPostId, workerId, attemptId,
          state, externalPostId, externalContainerId, errorCode, errorMessage, nextAttemptAt, at });
      if (result.changes !== 1) throw new Error("job lease is not owned by this attempt");
      db.prepare(`UPDATE scheduled_post_attempts SET finished_at=?, outcome=?, external_container_id=?, external_post_id=?,
        error_code=?, error_message=? WHERE id=? AND scheduled_post_id=?`)
        .run(at, state, externalContainerId, externalPostId, errorCode, errorMessage, attemptId, scheduledPostId);
    });
  }

  const markSent = (args) => finish({ ...args, state: "sent" });
  const markFailed = (args) => finish({ ...args, state: "failed" });
  const markAmbiguous = (args) => finish({ ...args, state: "ambiguous", nextAttemptAt: null });

  function recoverExpiredLeases({ expiredBefore = now() } = {}) {
    return withTransaction(db, () => {
      const ambiguous = db.prepare(`UPDATE scheduled_post_jobs SET state='ambiguous', lease_owner=NULL, lease_expires_at=NULL,
        last_error_code='lease_expired_after_request', updated_at=?, version=version+1
        WHERE state='processing' AND lease_expires_at < ? AND request_started_at IS NOT NULL`).run(expiredBefore, expiredBefore).changes;
      const retryable = db.prepare(`UPDATE scheduled_post_jobs SET state='pending', current_attempt_id=NULL,
        lease_owner=NULL, lease_expires_at=NULL, last_error_code='lease_expired_before_request', updated_at=?, version=version+1
        WHERE state='processing' AND lease_expires_at < ? AND request_started_at IS NULL`).run(expiredBefore, expiredBefore).changes;
      return { ambiguous, retryable };
    });
  }

  function markDone(scheduledPostId, at = now()) {
    const result = db.prepare(`UPDATE scheduled_post_jobs SET state='done', completed_at=?, updated_at=?, version=version+1
      WHERE scheduled_post_id=? AND state='sent' AND NOT EXISTS (
        SELECT 1 FROM scheduled_post_effects WHERE scheduled_post_id=? AND state NOT IN ('done','skipped'))`)
      .run(at, at, scheduledPostId, scheduledPostId);
    return result.changes === 1;
  }

  function cancel(scheduledPostId, at = now()) {
    return withTransaction(db, () => {
      const result = db.prepare(`UPDATE scheduled_post_jobs SET state='canceled',lease_owner=NULL,lease_expires_at=NULL,
        completed_at=?,updated_at=?,version=version+1 WHERE scheduled_post_id=? AND state IN ('pending','failed')`)
        .run(at, at, scheduledPostId);
      if (result.changes === 1) {
        db.prepare("UPDATE scheduled_posts SET lifecycle_state='canceled',updated_at=? WHERE id=?").run(at, scheduledPostId);
      }
      return result.changes === 1;
    });
  }

  return { claimNext, markRequestStarted, recordExternalContainer, get, markSent, markFailed, markAmbiguous, recoverExpiredLeases, markDone, cancel };
}

module.exports = { createScheduledPostJobRepository };
