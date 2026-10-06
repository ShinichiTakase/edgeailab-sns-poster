const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { decryptSecret } = require("../security/tokenCrypto");
const { customerShape, scheduleShape, textShape, postShape, logShape } = require("../data/sqliteStoreAdapters");
const { canonicalJson, contentHash } = require("./canonicalJson");

function reverseExport(db, { keyring, includeSecrets = false } = {}) {
  const microcms = {
    customers: db.prepare("SELECT * FROM customers ORDER BY id").all().map(r=>customerShape(db,r)),
    post_schedules: db.prepare("SELECT * FROM schedules ORDER BY id").all().map(r=>scheduleShape(db,r)),
    schedule_texts: db.prepare("SELECT * FROM schedule_texts ORDER BY id").all().map(r=>textShape(db,r)),
    scheduled_posts: db.prepare("SELECT p.*,j.state job_state FROM scheduled_posts p JOIN scheduled_post_jobs j ON j.scheduled_post_id=p.id ORDER BY p.id").all().map(postShape),
    posting_logs: db.prepare("SELECT * FROM posting_logs ORDER BY id").all().map(logShape),
  };
  const json = { "client_tokens.json":{}, "sns_history.json":{}, "scheduled_post_retries.json":{},
    "posting_log_origins.json":{}, "announcements.json":[], "announcement_reads.json":{}, "x_surcharge_current.json":{} };
  for(const r of db.prepare("SELECT * FROM social_accounts ORDER BY id").all()){
    const owner=db.prepare("SELECT slug FROM customers WHERE id=?").get(r.customer_id)?.slug;if(!owner)continue;
    const ctx=`${r.platform}:${r.external_account_id}`;
    const entry={user_id:r.external_account_id,username:r.username,token_expires_at:r.token_expires_at,...JSON.parse(r.metadata_json||"{}")};
    if(includeSecrets){if(!keyring)throw new Error("keyring is required when includeSecrets=true");entry.access_token=decryptSecret(r.access_token_ciphertext,keyring,`${ctx}:access`);entry.refresh_token=decryptSecret(r.refresh_token_ciphertext,keyring,`${ctx}:refresh`);}
    else {entry.access_token="[REDACTED]";entry.refresh_token=r.refresh_token_ciphertext?"[REDACTED]":null;}
    (json["client_tokens.json"][owner]??={})[r.platform]=entry;
  }
  for(const r of db.prepare("SELECT * FROM social_account_history").all())json["sns_history.json"][`${r.platform}:${r.external_account_id}`]={firstCustomerId:r.first_customer_id,firstConnectedAt:r.first_connected_at};
  for(const r of db.prepare("SELECT * FROM scheduled_post_jobs WHERE state='failed'").all())json["scheduled_post_retries.json"][r.scheduled_post_id]={retryCount:Math.max(0,r.attempt_count-1),nextRetryAt:r.next_attempt_at};
  for(const r of db.prepare("SELECT id,scheduled_post_id FROM posting_logs WHERE scheduled_post_id IS NOT NULL").all())json["posting_log_origins.json"][r.id]={scheduledPostId:r.scheduled_post_id};
  json["announcements.json"]=db.prepare("SELECT * FROM notifications ORDER BY created_at").all().map(r=>({id:r.id,customerCode:r.customer_id,type:r.type,title:r.title,body:r.body,platform:r.platform,createdAt:r.created_at}));
  for(const r of db.prepare("SELECT * FROM notification_reads").all())json["announcement_reads.json"][r.user_id]=r.last_read_at;
  const active=db.prepare("SELECT * FROM x_surcharge_versions WHERE state='active'").get();if(active)json["x_surcharge_current.json"]={amountJpy:active.amount,priceIds:JSON.parse(active.stripe_prices_json)};
  return { microcms, json };
}
function writeReverseExport(bundle,directory){fs.mkdirSync(directory,{recursive:true,mode:0o700});for(const[k,v]of Object.entries(bundle.microcms))fs.writeFileSync(path.join(directory,`microcms-${k}.json`),canonicalJson(v)+"\n",{mode:0o600});for(const[k,v]of Object.entries(bundle.json))fs.writeFileSync(path.join(directory,k),canonicalJson(v)+"\n",{mode:0o600});}
function ids(rows){return rows.map(x=>x.id).sort();}
function one(v){return Array.isArray(v)?v[0]||"":v||"";}
function userMajor(u){return {userId:u.userId||"",email:u.email||"",name:u.name||"",passwordHash:u.passwordHash||null,role:one(u.role),approverIds:(()=>{try{return [...JSON.parse(u.approverIds||"[]")].sort()}catch{return[]}})(),invitedBy:u.invitedBy||"",invitationStatus:one(u.invitationStatus),invitationExpiresAt:u.invitationExpiresAt||"",resetPasswordExpAt:u.resetPasswordExpAt||"",sessionVersion:Number(u.sessionVersion)||1};}
function major(name,row){
 if(name==="customers")return{id:row.id,slug:row.slug,email:row.email,companyName:row.companyName||"",contactName:row.contactName||"",status:one(row.status),plan:one(row.plan).toLowerCase(),isVerified:Boolean(row.isVerified),trialEndsAt:row.trialEndsAt||"",trialPostCount:Number(row.trialPostCount)||0,stripeCustomerId:row.stripeCustomerId||"",stripeSubscriptionId:row.stripeSubscriptionId||"",users:(row.users||[]).map(userMajor)};
 if(name==="post_schedules")return{id:row.id,customer_code:row.customer_code,created_by:row.created_by||"",name:row.name,platforms:[...(row.platforms||[])].sort(),url_mode:Boolean(row.url_mode),notify_email:Boolean(row.notify_email),start_date:row.start_date,end_date:row.end_date||"",weekdays:[...(row.weekdays||[])].sort(),daily_post_count:Number(row.daily_post_count),slot1_start:row.slot1_start||"",slot1_end:row.slot1_end||"",slot2_start:row.slot2_start||"",slot2_end:row.slot2_end||"",slot3_start:row.slot3_start||"",slot3_end:row.slot3_end||"",is_paused:Boolean(row.is_paused),auto_paused:Boolean(row.auto_paused),round_robin_index:Number(row.round_robin_index)||0,facebook_page_id:row.facebook_page_id||"",last_materialized_dt:row.last_materialized_dt||""};
 if(name==="schedule_texts")return{id:row.id,schedule_id:row.schedule_id,created_by:row.created_by||"",source_excerpt:row.source_excerpt||"",batch_id:row.batch_id||"",approval_status:one(row.approval_status)||"none",x_text:row.x_text||"",threads_text:row.threads_text||"",facebook_text:row.facebook_text||"",instagram_text:row.instagram_text||"",linkedin_text:row.linkedin_text||"",instagram_image_url:row.instagram_image_url||"",instagram_video_url:row.instagram_video_url||""};
 if(name==="scheduled_posts")return{id:row.id,customer_code:row.customer_code,created_by:row.created_by||"",source_schedule_id:row.source_schedule_id||"",platform:one(row.platform),content:row.content||"",scheduled_at:row.scheduled_at,status:one(row.status),contains_url:Boolean(row.contains_url),image_url:row.image_url||"",video_url:row.video_url||"",facebook_page_id:row.facebook_page_id||"",approval_status:one(row.approval_status)||"none"};
 return{id:row.id,customer_code:row.customer_code,created_by:row.created_by||"",platform:one(row.platform),content:row.content||"",platform_post_id:row.platform_post_id||null,account_name:row.account_name||"",posted_at:row.posted_at,billing_period:row.billing_period,contains_url:Boolean(row.contains_url)};
}
function verifyReverse(source,reverse){const endpoints=["customers","post_schedules","schedule_texts","scheduled_posts","posting_logs"];const results={};for(const name of endpoints){const a=source.microcms[name]||[],b=reverse.microcms[name]||[];results[name]={sourceCount:a.length,reverseCount:b.length,idSetMatch:contentHash(ids(a))===contentHash(ids(b)),sourceMajorHash:contentHash([...a].sort((x,y)=>x.id.localeCompare(y.id)).map(x=>major(name,x))),reverseMajorHash:contentHash([...b].sort((x,y)=>x.id.localeCompare(y.id)).map(x=>major(name,x)))};results[name].majorHashMatch=results[name].sourceMajorHash===results[name].reverseMajorHash;}return{results,countsAndIdsMatch:Object.values(results).every(x=>x.sourceCount===x.reverseCount&&x.idSetMatch),majorHashesMatch:Object.values(results).every(x=>x.majorHashMatch)};}
module.exports={reverseExport,writeReverseExport,verifyReverse};
