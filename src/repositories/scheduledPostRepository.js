const crypto = require("crypto");
const { withTransaction } = require("../db/transaction");

function createScheduledPostRepository(db, { now = () => new Date().toISOString(), uuid = () => crypto.randomUUID() } = {}) {
  function createWithJob(post, options = {}) {
    return withTransaction(db, () => {
      const timestamp = now();
      const id = post.id || uuid();
      const executionKey = options.executionKey || `scheduled-post:${id}`;
      db.prepare(`INSERT INTO scheduled_posts(
        id, customer_id, created_by_user_id, source_schedule_id, materialization_key, platform, content,
        scheduled_at, contains_url, image_url, video_url, facebook_page_id, notify_email,
        lifecycle_state, batch_id, approval_state, approval_requested_at, approval_expires_at, created_at, updated_at
      ) VALUES (@id,@customerId,@createdByUserId,@sourceScheduleId,@materializationKey,@platform,@content,
        @scheduledAt,@containsUrl,@imageUrl,@videoUrl,@facebookPageId,@notifyEmail,
        @lifecycleState,@batchId,@approvalState,@approvalRequestedAt,@approvalExpiresAt,@createdAt,@updatedAt)`)
        .run({ id, customerId: post.customerId, createdByUserId: post.createdByUserId || null,
          sourceScheduleId: post.sourceScheduleId || null, materializationKey: post.materializationKey || null,
          platform: post.platform, content: post.content || "", scheduledAt: post.scheduledAt,
          containsUrl: post.containsUrl ? 1 : 0, imageUrl: post.imageUrl || null, videoUrl: post.videoUrl || null,
          facebookPageId: post.facebookPageId || null, notifyEmail: post.notifyEmail == null ? null : (post.notifyEmail ? 1 : 0),
          lifecycleState: post.lifecycleState || "scheduled", batchId: post.batchId || null,
          approvalState: post.approvalState || "none", approvalRequestedAt: post.approvalRequestedAt || null,
          approvalExpiresAt: post.approvalExpiresAt || null, createdAt: timestamp, updatedAt: timestamp });
      db.prepare(`INSERT INTO scheduled_post_jobs(scheduled_post_id, execution_key, state, next_attempt_at, created_at, updated_at)
                  VALUES (?, ?, 'pending', ?, ?, ?)`).run(id, executionKey, post.scheduledAt, timestamp, timestamp);
      return getById(id);
    });
  }

  function getById(id) {
    return db.prepare(`SELECT p.*, j.execution_key, j.state AS job_state, j.attempt_count, j.lease_owner,
      j.lease_expires_at, j.external_post_id FROM scheduled_posts p
      JOIN scheduled_post_jobs j ON j.scheduled_post_id = p.id WHERE p.id = ?`).get(id) || null;
  }
  return { createWithJob, getById };
}

module.exports = { createScheduledPostRepository };
