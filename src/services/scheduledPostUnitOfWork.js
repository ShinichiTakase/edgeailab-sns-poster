const crypto = require("crypto");
const { withTransaction } = require("../db/transaction");
const { EFFECT_TYPES } = require("../repositories/effectRepository");

function createScheduledPostUnitOfWork(db, repositories, { now = () => new Date().toISOString(), uuid = () => crypto.randomUUID() } = {}) {
  function createReservation(post, options) {
    // Repository opens the transaction so all intent/job rows are committed together.
    return repositories.scheduledPosts.createWithJob(post, options);
  }

  function recordConfirmedSend({ scheduledPostId, customerId, createdByUserId = null, platform, content,
    externalPostId, accountName = "", containsUrl = false, postedAt = now(), meterEventName = "post_created" }) {
    return withTransaction(db, () => {
      const logId = `scheduled-post:${scheduledPostId}`;
      const billingPeriod = postedAt.slice(0, 7);
      db.prepare(`INSERT OR IGNORE INTO posting_logs(id,customer_id,created_by_user_id,scheduled_post_id,platform,content,
        external_post_id,account_name,posted_at,billing_period,contains_url,created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(logId, customerId, createdByUserId, scheduledPostId, platform, content || "", externalPostId,
          accountName, postedAt, billingPeriod, containsUrl ? 1 : 0, postedAt);
      for (const type of EFFECT_TYPES) {
        const state = type === "posting_log" ? "done" : "pending";
        db.prepare(`INSERT INTO scheduled_post_effects(scheduled_post_id,effect_type,idempotency_key,state,created_at,updated_at,completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scheduled_post_id,effect_type) DO NOTHING`)
          .run(scheduledPostId, type, `scheduled-post:${scheduledPostId}:${type}`, state, postedAt, postedAt,
            state === "done" ? postedAt : null);
      }
      repositories.meterEvents.ensure({ id: uuid(), idempotencyKey: `scheduled-post:${scheduledPostId}:stripe-meter`,
        customerId, postingLogId: logId, scheduledPostId, eventName: meterEventName, quantity: 1 });
      if (platform === "x" && containsUrl) repositories.meterEvents.ensure({ id: uuid(),
        idempotencyKey: `scheduled-post:${scheduledPostId}:stripe-meter:x-surcharge`, customerId,
        postingLogId: logId, scheduledPostId, eventName: "x_surcharge_post", quantity: 1 });
      return db.prepare("SELECT * FROM posting_logs WHERE scheduled_post_id=?").get(scheduledPostId);
    });
  }
  return { createReservation, recordConfirmedSend };
}

module.exports = { createScheduledPostUnitOfWork };
