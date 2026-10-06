const crypto = require("crypto");
const { withTransaction } = require("../db/transaction");
const { contentHash } = require("./canonicalJson");
const { choice, inspectExport } = require("./inspectExport");
const { encryptSecret } = require("../security/tokenCrypto");

const PLATFORM_MAP = { x: "x", threads: "threads", facebook: "facebook", instagram: "instagram", linkedin: "linkedin" };
const WEEKDAY_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
function bool(value) { return value ? 1 : 0; }
function nullable(value) { return value === "" || value == null ? null : value; }
function json(value) { return JSON.stringify(value == null ? {} : value); }
function tokenHash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function minutes(value) {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function createShadowImporter(db, { keyring, now = () => new Date().toISOString() }) {
  if (!keyring) throw new Error("keyring is required");
  function recordSource(runId, sourceType, sourceName, sourceId, source, targetTable, targetId) {
    const hash = contentHash(source);
    const existing = db.prepare(`SELECT source_hash FROM migration_imports WHERE source_type=? AND source_name=? AND source_id=?`)
      .get(sourceType, sourceName, sourceId);
    if (existing) {
      if (existing.source_hash !== hash) throw new Error(`source content changed: ${sourceType}/${sourceName}`);
      return false;
    }
    db.prepare(`INSERT INTO migration_imports(source_type,source_name,source_id,source_hash,target_table,target_id,migration_run_id,imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sourceType, sourceName, sourceId, hash, targetTable, targetId, runId, now());
    return true;
  }

  function importBundle(bundle) {
    const quality = inspectExport(bundle);
    if (quality.hasErrors) throw Object.assign(new Error("source data quality errors prevent import"), { quality });
    const manifestHash = bundle.manifest.manifestHash;
    const previous = db.prepare("SELECT id,status FROM migration_runs WHERE manifest_hash=?").get(manifestHash);
    if (previous && previous.status === "complete") return { rerun: true, runId: previous.id, quality };
    const runId = previous ? previous.id : crypto.randomUUID();
    return withTransaction(db, () => {
      if (!previous) db.prepare(`INSERT INTO migration_runs(id,manifest_hash,source_exported_at,started_at,status)
        VALUES (?, ?, ?, ?, 'running')`).run(runId, manifestHash, bundle.manifest.exportedAt, now());
      const m = bundle.microcms; const j = bundle.json;
      const userIds = new Set(m.customers.flatMap((c) => (c.users || []).map((u) => u.userId).filter(Boolean)));
      const customerBySlug = new Map(m.customers.map((c) => [c.slug, c]));
      const customerById = new Map(m.customers.map((c) => [c.id, c]));
      const quarantine = (sourceType, sourceName, sourceId, reason, payload) => db.prepare(`INSERT INTO migration_quarantine(
        migration_run_id,source_type,source_name,source_id_hash,reason,encrypted_payload,encryption_key_version,created_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source_type,source_name,source_id_hash,reason) DO NOTHING`).run(
          runId,sourceType,sourceName,tokenHash(sourceId),reason,
          encryptSecret(JSON.stringify(payload),keyring,`migration-quarantine:${sourceName}:${tokenHash(sourceId)}`),keyring.currentVersion,now());

      for (const c of m.customers) {
        if (!recordSource(runId, "microcms", "customers", c.id, c, "customers", c.id)) continue;
        db.prepare(`INSERT INTO customers(id,slug,primary_email,company_name,contact_name,status,plan,is_verified,
          verification_token_hash,verification_expires_at,trial_ends_at,trial_post_count,trial_limit_auto_activated_at,
          trial_reminder_sent_at,stripe_customer_id,stripe_subscription_id,canceled_at,source_created_at,source_updated_at,
          created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(c.id,c.slug,String(c.email).trim(),c.companyName||"",
          c.contactName||"",choice(c.status),choice(c.plan).toLowerCase(),bool(c.isVerified),c.verificationToken?tokenHash(c.verificationToken):null,
          nullable(c.verifyExpiresAt),nullable(c.trialEndsAt),Number(c.trialPostCount)||0,nullable(c.trialLimitAutoActivatedAt),
          c.trialReminderSent?c.updatedAt:null,nullable(c.stripeCustomerId),nullable(c.stripeSubscriptionId),nullable(c.canceledAt),
          nullable(c.createdAt),nullable(c.updatedAt),c.createdAt,c.updatedAt);
        for (let index=0; index<(c.users||[]).length; index++) {
          const u=c.users[index]; const role=choice(u.role); const invitationStatus=choice(u.invitationStatus)||null;
          db.prepare(`INSERT INTO users(id,customer_id,email,name,password_hash,role,is_owner,invited_by_user_id,invitation_status,
            invitation_token_hash,invitation_expires_at,reset_token_hash,reset_expires_at,session_version,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(u.userId,c.id,String(u.email).trim(),u.name||"",nullable(u.passwordHash),role,
            index===0?1:0,null,invitationStatus,u.invitationToken?tokenHash(u.invitationToken):null,nullable(u.invitationExpiresAt),
            u.resetPasswordToken?tokenHash(u.resetPasswordToken):null,nullable(u.resetPasswordExpAt),Number(u.sessionVersion)||1,c.createdAt,c.updatedAt);
        }
      }
      for (const c of m.customers) for (const u of c.users||[]) if (u.approverIds) {
        for (const approverId of JSON.parse(u.approverIds)) db.prepare(`INSERT INTO user_approvers(editor_user_id,approver_user_id,created_at) VALUES (?,?,?)`)
          .run(u.userId,approverId,c.updatedAt);
      }

      for (const s of m.post_schedules) {
        if (!recordSource(runId,"microcms","post_schedules",s.id,s,"schedules",s.id)) continue;
        const createdBy=userIds.has(s.created_by)?s.created_by:null;
        db.prepare(`INSERT INTO schedules(id,customer_id,created_by_user_id,source_created_by,name,url_mode,notify_email,start_date,end_date,
          daily_post_count,is_paused,auto_paused,round_robin_index,facebook_page_id,last_materialized_date,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(s.id,s.customer_code,createdBy,nullable(s.created_by),s.name,bool(s.url_mode),
          s.notify_email===false?0:1,s.start_date,nullable(s.end_date),Number(s.daily_post_count),bool(s.is_paused),bool(s.auto_paused),
          Number(s.round_robin_index)||0,nullable(s.facebook_page_id),nullable(s.last_materialized_dt),s.createdAt,s.updatedAt);
        for (const platform of s.platforms||[]) db.prepare("INSERT INTO schedule_platforms(schedule_id,platform) VALUES (?,?)").run(s.id,platform);
        for (const weekday of s.weekdays||[]) db.prepare("INSERT INTO schedule_weekdays(schedule_id,weekday) VALUES (?,?)").run(s.id,WEEKDAY_MAP[weekday]);
        for (let p=1;p<=3;p++) { const start=minutes(s[`slot${p}_start`]); const end=minutes(s[`slot${p}_end`]);
          if (start!=null&&end!=null) db.prepare("INSERT INTO schedule_slots(schedule_id,position,start_minute,end_minute) VALUES (?,?,?,?)").run(s.id,p,start,end); }
      }

      const importApprovals=(table,idColumn,row,targetId)=>{ if(!row.approvals_json)return; for(const a of JSON.parse(row.approvals_json||"[]")){
        db.prepare(`INSERT INTO ${table}(${idColumn},approver_user_id,token_hash,state,token_expires_at,responded_at,comment) VALUES (?,?,?,?,?,?,?)`)
          .run(targetId,a.approverId,tokenHash(a.token),a.status||"pending",a.tokenExpiresAt,nullable(a.respondedAt),nullable(a.comment)); }};
      for (const t of m.schedule_texts) {
        if (!recordSource(runId,"microcms","schedule_texts",t.id,t,"schedule_texts",t.id)) continue;
        db.prepare(`INSERT INTO schedule_texts(id,schedule_id,created_by_user_id,source_created_by,source_excerpt,batch_id,approval_state,
          approval_requested_at,approval_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(t.id,t.schedule_id,
          userIds.has(t.created_by)?t.created_by:null,nullable(t.created_by),t.source_excerpt||"",nullable(t.batch_id),choice(t.approval_status)||"none",
          nullable(t.appr_requested_at),nullable(t.appr_expires_at),t.createdAt,t.updatedAt);
        const variants={x:t.x_text,threads:t.threads_text,facebook:t.facebook_text,instagram:t.instagram_text,linkedin:t.linkedin_text};
        for(const [platform,content] of Object.entries(variants)) if(content) db.prepare(`INSERT INTO schedule_text_variants(schedule_text_id,platform,content,image_url,video_url) VALUES (?,?,?,?,?)`)
          .run(t.id,platform,content,platform==="instagram"?nullable(t.instagram_image_url):null,platform==="instagram"?nullable(t.instagram_video_url):null);
        importApprovals("schedule_text_approvals","schedule_text_id",t,t.id);
      }

      const retry=j["scheduled_post_retries.json"]||{};
      for (const p of m.scheduled_posts) {
        if (!recordSource(runId,"microcms","scheduled_posts",p.id,p,"scheduled_posts",p.id)) continue;
        const status=choice(p.status); const approval=choice(p.approval_status)||"none"; const retryInfo=retry[p.id];
        const validSourceSchedule=p.source_schedule_id&&m.post_schedules.some((s)=>s.id===p.source_schedule_id)?p.source_schedule_id:null;
        if(p.source_schedule_id&&!validSourceSchedule) quarantine("microcms","scheduled_posts",p.id,"orphan_source_schedule",{sourceScheduleId:p.source_schedule_id});
        db.prepare(`INSERT INTO scheduled_posts(id,customer_id,created_by_user_id,source_created_by,source_schedule_id,source_schedule_id_raw,platform,content,
          scheduled_at,contains_url,image_url,video_url,facebook_page_id,notify_email,lifecycle_state,batch_id,approval_state,
          approval_requested_at,approval_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.id,p.customer_code,
          userIds.has(p.created_by)?p.created_by:null,nullable(p.created_by),validSourceSchedule,nullable(p.source_schedule_id),choice(p.platform),p.content||"",p.scheduled_at,
          bool(p.contains_url),nullable(p.image_url),nullable(p.video_url),nullable(p.facebook_page_id),p.notify_email == null ? null : bool(p.notify_email),"scheduled",
          nullable(p.batch_id),approval,nullable(p.appr_requested_at),nullable(p.appr_expires_at),p.createdAt,p.updatedAt);
        const retryExhausted=status==="failed"&&retryInfo&&Number(retryInfo.retryCount||0)>=3&&!retryInfo.nextRetryAt;
        db.prepare(`INSERT INTO scheduled_post_jobs(scheduled_post_id,execution_key,state,attempt_count,next_attempt_at,last_error_code,created_at,updated_at,completed_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(p.id,`scheduled-post:${p.id}`,status,retryInfo?1+Number(retryInfo.retryCount||0):0,
          retryInfo?nullable(retryInfo.nextRetryAt):null,retryExhausted?"legacy_retry_exhausted":null,
          p.createdAt,p.updatedAt,status==="done"?p.updatedAt:null);
        importApprovals("scheduled_post_approvals","scheduled_post_id",p,p.id);
      }

      const origins=j["posting_log_origins.json"]||{}; const usedPostOrigins=new Set();
      for (const l of m.posting_logs) {
        if (!recordSource(runId,"microcms","posting_logs",l.id,l,"posting_logs",l.id)) continue;
        const origin=origins[l.id]&&origins[l.id].scheduledPostId;
        const scheduledPostId=origin&&m.scheduled_posts.some((p)=>p.id===origin)&&!usedPostOrigins.has(origin)?origin:null;
        if(origin&&!scheduledPostId) quarantine("json","posting_log_origins.json",l.id,"unresolved_or_duplicate_origin",origins[l.id]);
        if(scheduledPostId)usedPostOrigins.add(scheduledPostId);
        db.prepare(`INSERT INTO posting_logs(id,customer_id,created_by_user_id,source_created_by,scheduled_post_id,platform,content,external_post_id,
          account_name,posted_at,billing_period,contains_url,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(l.id,l.customer_code,
          userIds.has(l.created_by)?l.created_by:null,nullable(l.created_by),scheduledPostId,choice(l.platform),l.content||"",nullable(l.platform_post_id),
          l.account_name||"",l.posted_at,l.billing_period,bool(l.contains_url),l.createdAt);
      }

      const tokens=j["client_tokens.json"]||{};
      for(const [owner,platforms] of Object.entries(tokens)){const customer=customerBySlug.get(owner)||customerById.get(owner);for(const [platform,entry] of Object.entries(platforms||{})){
        const sourceId=`${owner}:${platform}`;if(!recordSource(runId,"json","client_tokens.json",sourceId,entry,"social_accounts",sourceId))continue;
        const externalId=entry.user_id||`pages:${owner}`; const context=`${platform}:${externalId}`;
        const result=db.prepare(`INSERT INTO social_accounts(customer_id,platform,external_account_id,username,access_token_ciphertext,refresh_token_ciphertext,
          encryption_key_version,token_expires_at,metadata_json,connected_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(customer.id,platform,externalId,
          entry.username||"",encryptSecret(entry.access_token,keyring,`${context}:access`),encryptSecret(entry.refresh_token,keyring,`${context}:refresh`),
          keyring.currentVersion,nullable(entry.token_expires_at),json({permissions:entry.permissions||null}),entry.updated_at||customer.updatedAt,entry.updated_at||customer.updatedAt);
        for(const page of entry.pages||[])db.prepare(`INSERT INTO social_account_pages(social_account_id,external_page_id,page_name,access_token_ciphertext,
          encryption_key_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).run(result.lastInsertRowid,page.pageId,page.pageName||"",
          encryptSecret(page.pageAccessToken,keyring,`facebook-page:${page.pageId}:access`),keyring.currentVersion,entry.updated_at,entry.updated_at);
      }}
      for(const [key,entry] of Object.entries(j["sns_history.json"]||{})){if(!recordSource(runId,"json","sns_history.json",key,entry,"social_account_history",key))continue;
        const split=key.indexOf(":");db.prepare(`INSERT INTO social_account_history(platform,external_account_id,first_customer_id,first_connected_at) VALUES (?,?,?,?)`)
          .run(key.slice(0,split),key.slice(split+1),entry.firstCustomerId,entry.firstConnectedAt);}
      for(const a of j["announcements.json"]||[]){if(!recordSource(runId,"json","announcements.json",a.id,a,"notifications",a.id))continue;
        db.prepare(`INSERT INTO notifications(id,customer_id,type,title,body,platform,related_entity_type,related_entity_id,dedupe_key,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(a.id,a.customerCode,a.type,a.title,a.body,nullable(a.platform),null,null,`legacy-announcement:${a.id}`,a.createdAt);}
      for(const [userId,lastReadAt] of Object.entries(j["announcement_reads.json"]||{})){if(!recordSource(runId,"json","announcement_reads.json",userId,lastReadAt,"notification_reads",userId))continue;
        db.prepare("INSERT INTO notification_reads(user_id,last_read_at) VALUES (?,?)").run(userId,lastReadAt);}
      const surcharge=j["x_surcharge_current.json"];
      if(surcharge&&Object.keys(surcharge).length&&recordSource(runId,"json","x_surcharge_current.json","current",surcharge,"x_surcharge_versions","current")){
        const isReference=surcharge.amountJpy==null;
        db.prepare(`INSERT INTO x_surcharge_versions(amount,reference_usd,reference_usd_updated_at,effective_at,state,stripe_prices_json,created_at)
          VALUES (?,?,?,?,?,?,?)`).run(surcharge.amountJpy??null,surcharge.referenceUsd??null,nullable(surcharge.referenceUsdUpdatedAt),
          surcharge.updatedAt||surcharge.referenceUsdUpdatedAt,isReference?"reference":"active",json(surcharge.priceIds||{}),surcharge.updatedAt||surcharge.referenceUsdUpdatedAt);
      }
      const reservation=j["x_surcharge_reservation.json"];
      if(reservation&&recordSource(runId,"json","x_surcharge_reservation.json","reservation",reservation,"x_surcharge_versions","reservation"))
        db.prepare(`INSERT INTO x_surcharge_versions(amount,effective_at,state,stripe_prices_json,created_at) VALUES (?,?,'scheduled','{}',?)`)
          .run(reservation.amountJpy,reservation.effectiveDate,reservation.createdAt);

      const postIds=new Set(m.scheduled_posts.map((p)=>p.id)); const logIds=new Set(m.posting_logs.map((l)=>l.id));
      for(const [logId,origin] of Object.entries(origins)){
        const valid=logIds.has(logId)&&origin&&postIds.has(origin.scheduledPostId);
        recordSource(runId,"json","posting_log_origins.json",logId,origin,valid?"posting_logs":null,logIds.has(logId)?logId:null);
        if(!valid) quarantine("json","posting_log_origins.json",logId,"stale_origin",origin);
      }
      for(const [postId,info] of Object.entries(retry)){
        const valid=postIds.has(postId); recordSource(runId,"json","scheduled_post_retries.json",postId,info,valid?"scheduled_post_jobs":null,valid?postId:null);
        if(!valid) quarantine("json","scheduled_post_retries.json",postId,"stale_retry",info);
      }
      for(const [name,value] of Object.entries(j)) if(value!=null&&!['client_tokens.json','sns_history.json','announcements.json','announcement_reads.json','x_surcharge_current.json','x_surcharge_reservation.json','posting_log_origins.json','scheduled_post_retries.json'].includes(name)){
        recordSource(runId,"json",name,"$",value,null,null);
      }
      const report={quality, importedAt:now()};
      db.prepare("UPDATE migration_runs SET status='complete',completed_at=?,report_json=? WHERE id=?").run(now(),json(report),runId);
      return { rerun:false,runId,quality };
    });
  }
  return { importBundle };
}

module.exports = { createShadowImporter };
