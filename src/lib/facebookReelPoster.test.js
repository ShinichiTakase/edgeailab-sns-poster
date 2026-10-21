const test=require('node:test'), assert=require('node:assert/strict');
const {createFacebookReelPoster}=require('./facebookReelPoster');
function fixture({fail,existingContainerId,uploadStage,publishStartedAt}={}) {
 const calls=[],stages=[];let published=false;
 const api=createFacebookReelPoster({sleep:async()=>{},polls:2,fetchImpl:async(url,opts)=>{
  const body=opts.body?JSON.parse(opts.body):{}; calls.push({url,body,headers:opts.headers});
  if(fail && fail({url,body}))throw Error('network');
  if(body.upload_phase==='finish')published=true;
  return {ok:true,json:async()=>body.upload_phase==='start'?{video_id:'123'}:url.includes('?fields=')?{status:{uploading_phase:{status:'complete'},publishing_phase:{status:published?'complete':'not_started'}}}:{success:true}};
 }});
 const lifecycle={existingContainerId,uploadStage,publishStartedAt,onContainerCreated:async id=>assert.equal(id,'123'),onStage:async s=>stages.push(s)};
 return {calls,stages,run:()=>api.postReel({pageId:'selected-page',pageAccessToken:'test-token'},'caption','https://example.test/video.mp4',lifecycle),lifecycle};
}
test('selected Page upload publish confirmation and durable order',async()=>{const f=fixture();assert.equal((await f.run()).id,'123');assert.deepEqual(f.stages,['start_requested','created','upload_requested','uploaded','publish_requested','published']);assert.ok(f.calls[0].url.endsWith('/selected-page/video_reels'));assert.equal(f.calls[1].headers.file_url,'https://example.test/video.mp4');});
test('resume existing ID without new upload',async()=>{const f=fixture({existingContainerId:'123',uploadStage:'uploaded'});await f.run();assert.equal(f.calls.filter(c=>c.body.upload_phase==='start'||c.url.includes('rupload')).length,0);});
test('lost publish response is not retry safe',async()=>{const f=fixture({fail:({body})=>body.upload_phase==='finish'});await assert.rejects(f.run(),e=>e.retrySafe===false);assert.equal(f.stages.at(-1),'publish_requested');});
test('upload timeout preserves external ID for retry',async()=>{const f=fixture({fail:({url})=>url.includes('rupload')});await assert.rejects(f.run(),e=>e.retrySafe===true);});
test('publish barrier DB failure prevents publishing',async()=>{const f=fixture();f.lifecycle.onStage=async s=>{if(s==='publish_requested')throw Error('database unavailable');};await assert.rejects(f.run());assert.equal(f.calls.filter(c=>c.body.upload_phase==='finish').length,0);});
test('previous publish request only reconciles and never publishes again',async()=>{const f=fixture({existingContainerId:'123',uploadStage:'publish_requested',publishStartedAt:'2026-10-15'});await assert.rejects(f.run(),e=>!e.retrySafe);assert.equal(f.calls.filter(c=>c.body.upload_phase).length,0);});
test('missing durable lifecycle rejects before external request',async()=>{let calls=0;const p=createFacebookReelPoster({fetchImpl:()=>calls++});await assert.rejects(p.postReel({},'','url'));assert.equal(calls,0);});
test('cover failure after publication is recorded without resending',async()=>{const calls=[],stages=[];let published=false;const api=createFacebookReelPoster({sleep:async()=>{},polls:1,fetchImpl:async(url,opts)=>{calls.push(url);if(url.endsWith('/thumbnails')){assert.ok(opts.body instanceof FormData);throw Error('cover timeout');}const body=opts.body?JSON.parse(opts.body):{};if(body.upload_phase==='finish')published=true;return{ok:true,json:async()=>body.upload_phase==='start'?{video_id:'123'}:url.includes('?fields=')?{status:{uploading_phase:{status:'complete'},publishing_phase:{status:published?'complete':'not_started'}}}:{success:true}};}});const result=await api.postReel({pageId:'page2',pageAccessToken:'fake'},'test','url',{onContainerCreated:async()=>{},onStage:async s=>stages.push(s),coverBuffer:Buffer.from('fake-jpeg')});assert.equal(result.id,'123');assert.equal(stages.at(-1),'published_cover_unconfirmed');assert.equal(calls.filter(u=>u.endsWith('/video_reels')).length,2);});
