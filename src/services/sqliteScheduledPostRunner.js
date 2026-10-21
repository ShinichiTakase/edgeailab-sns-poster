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
    return db.prepare(`SELECT p.*,s.notify_email AS schedule_notify_email,j.external_container_id,j.upload_stage,j.publish_started_at
      FROM scheduled_posts p LEFT JOIN schedules s ON s.id=p.source_schedule_id
      JOIN scheduled_post_jobs j ON j.scheduled_post_id=p.id WHERE p.id=?`).get(id);
  }

  async function runOne() {
    const at = now();
    const job = repositories.jobs.claimNext({ workerId, dueAt: at, leaseExpiresAt: addMs(at, leaseMs) });
    if (!job) return null;
    const post = joinedPost(job.scheduled_post_id);
    if(post.platform === "facebook" && post.post_kind === "reel") post.platform = "facebook_reel";
    const ownership = { scheduledPostId: post.id, workerId, attemptId: job.current_attempt_id };
    const heartbeat = () => repositories.jobs.heartbeat({ ...ownership, at: now(), leaseExpiresAt: addMs(now(), leaseMs) });
    let leaseError;
    const timer = setInterval(() => { try { heartbeat(); } catch(e) { leaseError=e; } }, Math.max(100, Math.floor(leaseMs/3)));
    timer.unref();
    let requestStarted = false;
    try {
      await beforeRequest(post);
      repositories.jobs.markRequestStarted({ scheduledPostId: post.id, workerId, attemptId: job.current_attempt_id, at: now() });
      requestStarted = true;
      const result = await postToPlatform(post, {
        existingContainerId: post.external_container_id,
        uploadStage: post.upload_stage, publishStartedAt: post.publish_started_at,
        assertLease: async () => { if(leaseError) throw leaseError; heartbeat(); },
        onStage: async stage => { if(leaseError) throw leaseError; repositories.jobs.recordStage({...ownership,stage,at:now()}); },
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
      // A confirmed send is never converted back to a sendable job by an effect failure.
      const current = repositories.jobs.get(post.id);
      if (["sent", "done"].includes(current.state)) return { scheduledPostId: post.id, state: current.state, error };
      if (current.state !== "processing" || current.current_attempt_id !== job.current_attempt_id) return { scheduledPostId: post.id, state: current.state, error };
      const args = { scheduledPostId: post.id, workerId, attemptId: job.current_attempt_id,
        errorCode: error.code || "sns_request_failed", errorMessage: String(error.message || error).slice(0, 1000), at: now() };
      if (requestStarted && !error.retrySafe) repositories.jobs.markAmbiguous(args);
      else repositories.jobs.markFailed({ ...args, nextAttemptAt: job.attempt_count < 4 ? addMs(now(), 180000) : null });
      return { scheduledPostId: post.id, state: requestStarted && !error.retrySafe ? "ambiguous" : "failed", error };
    } finally { clearInterval(timer); }
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
