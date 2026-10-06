const fs=require("fs");const {openDatabase}=require("../db/connection");const {createRepositories}=require("../repositories");
function arg(name){const i=process.argv.indexOf(name);if(i<0)throw new Error(`${name} required`);return process.argv[i+1];}
async function main(){const sourcePath=arg("--source");const clonePath=arg("--clone");if(fs.existsSync(clonePath))throw new Error("scheduler clone already exists");
 const source=openDatabase(sourcePath,{readonly:true});try{await source.backup(clonePath);}finally{source.close();}
 const db=openDatabase(clonePath);try{let sequence=0;const repos=createRepositories(db,{now:()=>"2099-01-01T00:00:00.000Z",uuid:()=>`shadow-attempt-${++sequence}`});
  const lease="2099-01-01T00:10:00.000Z";const first=repos.jobs.claimNext({workerId:"shadow-worker-1",leaseExpiresAt:lease,dueAt:"2099-01-01T00:00:00.000Z"});
  if(!first)throw new Error("no pending shadow job available");const firstId=first.scheduled_post_id;
  repos.jobs.markFailed({scheduledPostId:firstId,workerId:"shadow-worker-1",attemptId:first.current_attempt_id,errorCode:"fixture",nextAttemptAt:"2099-01-01T00:00:00.000Z"});
  const retry=repos.jobs.claimNext({workerId:"shadow-worker-2",leaseExpiresAt:lease,dueAt:"2099-01-01T00:00:00.000Z"});
  repos.jobs.markRequestStarted({scheduledPostId:retry.scheduled_post_id,workerId:"shadow-worker-2",attemptId:retry.current_attempt_id});
  repos.jobs.markAmbiguous({scheduledPostId:retry.scheduled_post_id,workerId:"shadow-worker-2",attemptId:retry.current_attempt_id,errorCode:"fixture_timeout"});
  const cancelRow=db.prepare("SELECT scheduled_post_id FROM scheduled_post_jobs WHERE state='pending' LIMIT 1").get();const canceled=cancelRow?repos.jobs.cancel(cancelRow.scheduled_post_id):false;
  const sentClaim=repos.jobs.claimNext({workerId:"shadow-worker-3",leaseExpiresAt:lease,dueAt:"2099-01-01T00:00:00.000Z"});
  let done=false;if(sentClaim){repos.jobs.markRequestStarted({scheduledPostId:sentClaim.scheduled_post_id,workerId:"shadow-worker-3",attemptId:sentClaim.current_attempt_id});
    repos.jobs.markSent({scheduledPostId:sentClaim.scheduled_post_id,workerId:"shadow-worker-3",attemptId:sentClaim.current_attempt_id,externalPostId:"shadow-only"});
    repos.effects.ensureAll(sentClaim.scheduled_post_id);db.prepare("UPDATE scheduled_post_effects SET state='done' WHERE scheduled_post_id=?").run(sentClaim.scheduled_post_id);
    done=repos.jobs.markDone(sentClaim.scheduled_post_id);}
  const result={claimUnique:db.prepare("SELECT count(*) n FROM scheduled_post_attempts WHERE scheduled_post_id=?").get(firstId).n===2,
    failedRetrySameJob:retry.scheduled_post_id===firstId,ambiguousState:db.prepare("SELECT state FROM scheduled_post_jobs WHERE scheduled_post_id=?").get(firstId).state==="ambiguous",
    ambiguousNotClaimable:repos.jobs.claimNext({workerId:"shadow-worker-4",leaseExpiresAt:lease,dueAt:"2099-01-01T00:00:00.000Z"})?.scheduled_post_id!==firstId,
    canceled,done,sourceDatabaseModified:false};console.log(JSON.stringify(result));
 }finally{db.close();}}
if(require.main===module)main().catch((e)=>{console.error(e.message);process.exitCode=1});
