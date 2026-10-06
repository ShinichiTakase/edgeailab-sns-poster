const COVERAGE = Object.freeze([
  // A: canonical business data. Database triggers journal every row in the same transaction.
  ...["createCustomer","updateCustomer","markVerified","bumpTrialPostCount","setPasswordResetToken","resetPassword","adminSetPassword","changePassword","addInvitedUser","reissueInvitation","acceptInvitation","removeMember","reactivateCustomer"].map(api=>({api:`customerStore.${api}`,category:"A",tables:["customers","users","user_approvers"]})),
  ...["createSchedule","updateSchedule","deleteSchedule"].map(api=>({api:`scheduleStore.${api}`,category:"A",tables:["schedules","schedule_platforms","schedule_weekdays","schedule_slots"]})),
  ...["createScheduleText","updateScheduleText","deleteScheduleText"].map(api=>({api:`scheduleTextStore.${api}`,category:"A",tables:["schedule_texts","schedule_text_variants","schedule_text_approvals"]})),
  {api:"scheduledPostStore.createScheduledPost",category:"A",tables:["scheduled_posts","scheduled_post_approvals","scheduled_post_jobs"]},
  {api:"scheduledPostStore.deleteScheduledPost",category:"A",tables:["scheduled_posts"]},
  ...["createPostingLog","deletePostingLog"].map(api=>({api:`postingLogStore.${api}`,category:"A",tables:["posting_logs"]})),
  ...["savePlatformTokens","deletePlatformTokensByUserId","deletePlatformTokensBySlug"].map(api=>({api:`tokenStore.${api}`,category:"A",tables:["social_accounts","social_account_pages"],secretSafe:true})),
  {api:"snsHistoryStore.recordNewIdentifiers",category:"A",tables:["social_account_history"]},
  {api:"postingLogOriginStore.recordScheduledOrigin",category:"A",tables:["posting_logs"]},
  ...["createAnnouncement","markRead"].map(api=>({api:`announcementStore.${api}`,category:"A",tables:["notifications","notification_reads"]})),
  ...["setCurrent","setXReferenceUsd","setReservation","clearReservation"].map(api=>({api:`xSurchargeStore.${api}`,category:"A",tables:["x_surcharge_versions"]})),
  ...["decideApproval","checkExpiredApprovals"].map(api=>({api:`approvalStore.${api}`,category:"A",tables:["schedule_text_approvals","scheduled_post_approvals","schedule_texts","scheduled_posts"],secretSafe:true})),
  {api:"socialAccountRepository.upsert",category:"A",tables:["social_accounts"],secretSafe:true},
  {api:"scheduledPostRepository.createWithJob",category:"A",tables:["scheduled_posts","scheduled_post_jobs"]},

  // B: purpose-built immutable attempt/state/effect ledgers are the audit source.
  ...["claimNext","markRequestStarted","recordExternalContainer","markSent","markFailed","markAmbiguous","recoverExpiredLeases","markDone","cancel"].map(api=>({api:`scheduledPostJobRepository.${api}`,category:"B",tables:["scheduled_post_jobs","scheduled_post_attempts"]})),
  ...["ensure","ensureAll","claim","finish","recoverExpiredLeases","runLocal"].map(api=>({api:`effectRepository.${api}`,category:"B",tables:["scheduled_post_effects"]})),
  ...["ensure","claim","finish"].map(api=>({api:`meterEventRepository.${api}`,category:"B",tables:["billing_meter_events"]})),
  ...["begin","finish"].map(api=>({api:`stripeWebhookRepository.${api}`,category:"B",tables:["stripe_webhook_events"]})),
  {api:"scheduledPostUnitOfWork.recordConfirmedSend",category:"B",tables:["posting_logs","scheduled_post_effects","billing_meter_events"]},

  // C: short-lived technical state or migration/schema administration.
  ...["create","consume"].map(api=>({api:`oauthStateRepository.${api}`,category:"C",tables:["oauth_states"],secretSafe:true})),
  ...["put","take"].map(api=>({api:`pkceStore.${api}`,category:"C",tables:["oauth_states"],secretSafe:true})),
  ...["migrate","rollbackLast"].map(api=>({api:`migrationRunner.${api}`,category:"C",tables:["schema_migrations"]})),
  ...["writeCache"].map(api=>({api:`adminStats.${api}`,category:"C",tables:["admin_stats_cache"]})),
  {api:"shadowImporter.importBundle",category:"C",tables:["migration_runs","migration_imports","migration_quarantine"]},
  ...["record","mutate"].map(api=>({api:`changeJournal.${api}`,category:"C",tables:["change_journal"],secretSafe:true})),
]);

const JOURNALED_TABLES=Object.freeze(["customers","users","user_approvers","social_accounts","social_account_pages","social_account_history","schedules","schedule_platforms","schedule_weekdays","schedule_slots","schedule_texts","schedule_text_variants","schedule_text_approvals","scheduled_posts","scheduled_post_approvals","posting_logs","notifications","notification_reads","x_surcharge_versions"]);
const LEDGER_TABLES=Object.freeze(["scheduled_post_jobs","scheduled_post_attempts","scheduled_post_effects","billing_meter_events","stripe_webhook_events"]);
const TECHNICAL_TABLES=Object.freeze(["oauth_states","schema_migrations","migration_runs","migration_imports","migration_quarantine","change_journal","audit_logs","admin_stats_cache"]);
module.exports={COVERAGE,JOURNALED_TABLES,LEDGER_TABLES,TECHNICAL_TABLES};
