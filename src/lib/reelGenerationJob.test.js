process.env.SNS_POSTER_DATA_SOURCE='test-legacy';
const test=require('node:test'),assert=require('node:assert/strict');
require('./generationConfig').getDocsNumber=()=>1;
require('./postCopyGenerator').generatePostCopyVariations=async()=>({instagram:['共通動画']});
let calls=0;
require('./videoGenerator').renderVideo=async({signal})=>{calls++;await new Promise((resolve,reject)=>{if(signal.aborted)return reject(Object.assign(Error('canceled'),{name:'AbortError'}));signal.addEventListener('abort',()=>reject(Object.assign(Error('canceled'),{name:'AbortError'})),{once:true});});};
const jobs=require('./videoGenerationJobStore');
test('shared generation is one job and cancellation ends rendering',async()=>{const job=jobs.startVideoGenerationJob({sourceText:'synthetic'});await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.equal(jobs.serializeJob(job).slots[0].status,'rendering');assert.equal(jobs.cancelJob(job.id),true);await new Promise(r=>setImmediate(r));assert.equal(job.status,'canceled');assert.equal(job.slots[0].status,'canceled');});
