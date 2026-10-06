const crypto = require("crypto");
const { createRepositories } = require("../repositories");
const { createScheduledPostUnitOfWork } = require("./scheduledPostUnitOfWork");

function addMs(iso, ms) { return new Date(Date.parse(iso) + ms).toISOString(); }

function createSqliteScheduledPostRunner(db, {
  postToPlatform,
  beforeRequest = async () => {},
  effectHandlers = {},
  keyring,
  now = () => new Date().toISOString(),
  workerId = `scheduler:${process.pid}:${crypto.randomUUID()}`,
  leaseMs = 120000,
} = {}) {
  if (typeof postToPlatform !== "function") throw new Error("postToPlatform is required");
  const repositories = createRepositories(db, { keyring, now });
  const unit = createScheduledPostUnitOfWork(db, repositories, { now });

  function joinedPost(id) {
    return db.prepare(`SELECT p.*,s.notify_email AS schedule_notify_email,j.external_container_id
      FROM scheduled_posts p LEFT JOIN schedules s ON s.id=p.source_schedule_id
      JOIN scheduled_post_jobs j ON j.scheduled_post_id=p.id WHERE p.id=?`).get(id);
  }

  async function runOne() {
    const at = now();
    const job = repositories.jobs.claimNext({ workerId, dueAt: at, leaseExpiresAt: addMs(at, leaseMs) });
    if (!job) return null;
    const post = joinedPost(job.scheduled_post_id);
    let requestStarted = false;
    try {
      await beforeRequest(post);
      repositories.jobs.markRequestStarted({ scheduledPostId: post.id, workerId, attemptId: job.current_attempt_id, at: now() });
      requestStarted = true;
      const result = await postToPlatform(post, {
        existingContainerId: post.external_container_id,
        onContainerCreated: async (containerId) => repositories.jobs.recordExternalContainer({
          scheduledPostId: post.id, workerId, attemptId: job.current_attempt_id, externalContainerId: containerId, at: now(),
        }),
      });
      if (!result || !result.id) throw Object.assign(new Error("SNS response did not contain a post ID"), { ambiguous: true });
      repositories.jobs.markSent({ scheduledPostId: post.id, workerId, attemptId: job.current_attempt_id,
        externalPostId: result.id, externalContainerId: result.containerId || post.external_container_id, at: now() });
      unit.recordConfirmedSend({ scheduledPostId: post.id, customerId: post.customer_id,
        createdByUserId: post.created_by_user_id, platform: post.platform, content: post.content,
        externalPostId: result.id, containsUrl: Boolean(post.contains_url), postedAt: now() });
      await runEffects(post.id);
      return { scheduledPostId: post.id, state: repositories.jobs.get(post.id).state };
    } catch (error) {
      const args = { scheduledPostId: post.id, workerId, attemptId: job.current_attempt_id,
        errorCode: error.code || "sns_request_failed", errorMessage: String(error.message || error).slice(0, 1000), at: now() };
      if (requestStarted && !error.retrySafe) repositories.jobs.markAmbiguous(args);
      else repositories.jobs.markFailed({ ...args, nextAttemptAt: addMs(now(), 180000) });
      return { scheduledPostId: post.id, state: requestStarted && !error.retrySafe ? "ambiguous" : "failed", error };
    }
  }

  async function runEffects(scheduledPostId) {
    for (const effect of repositories.effects.listForPost(scheduledPostId)) {
      if (["done", "skipped"].includes(effect.state)) continue;
      const at = now();
      const local = ["posting_log", "trial_post_count", "notification"].includes(effect.effect_type);
      const handler = effectHandlers[effect.effect_type];
      if (local) {
        if (!handler) continue;
        repositories.effects.runLocal(effect.id, { workerId, at, leaseExpiresAt: addMs(at, leaseMs) },
          (claimed) => handler({ effect: claimed, idempotencyKey: effect.idempotency_key, scheduledPostId }));
        continue;
      }
      const claimed = repositories.effects.claim({ effectId: effect.id, workerId, at, leaseExpiresAt: addMs(at, leaseMs) });
      if (!claimed) continue;
      if (!handler) { repositories.effects.finish(effect.id, { state: "failed", errorCode: "handler_not_configured", at: now() }); continue; }
      try {
        const result = await handler({ effect: claimed, idempotencyKey: effect.idempotency_key, scheduledPostId });
        repositories.effects.finish(effect.id, { state: "done", externalReference: result?.externalReference || null, at: now() });
      } catch (error) {
        const external = effect.effect_type === "stripe_meter" || effect.effect_type === "email";
        repositories.effects.finish(effect.id, { state: external && !error.retrySafe ? "ambiguous" : "failed",
          errorCode: error.code || "effect_failed", errorMessage: String(error.message || error).slice(0, 1000),
          nextAttemptAt: external && !error.retrySafe ? null : addMs(now(), 180000), at: now() });
      }
    }
    repositories.jobs.markDone(scheduledPostId, now());
  }

  function recoverExpiredLeases() {
    return { jobs: repositories.jobs.recoverExpiredLeases({ expiredBefore: now() }),
      effects: repositories.effects.recoverExpiredLeases({ expiredBefore: now() }) };
  }
  return { runOne, runEffects, recoverExpiredLeases, repositories };
}

module.exports = { createSqliteScheduledPostRunner };
