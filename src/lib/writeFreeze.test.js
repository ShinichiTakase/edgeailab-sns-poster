const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const { openDatabase } = require("../db/connection");
const { migrate } = require("../db/migrationRunner");
const { writeFreezeMiddleware } = require("./writeFreeze");

function request(server, method, route, body = "") { return new Promise((resolve, reject) => { const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path: route, headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body), "stripe-signature": "fixture" } : {} }, (res) => { const chunks=[]; res.on("data",(c)=>chunks.push(c)); res.on("end",()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()})); }); req.on("error",reject); if(body)req.write(body); req.end(); }); }

test("freeze blocks HTTP writes and OAuth GET while read-only API stays available", async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"freeze-http-")), sentinel=path.join(dir,"freeze"); fs.writeFileSync(sentinel,"");
  const app=express(); app.use(writeFreezeMiddleware({env:{SNS_POSTER_WRITE_FREEZE_PATH:sentinel}})); app.get("/api/read",(_,res)=>res.json({ok:true})); app.post("/api/write",(_,res)=>res.json({ok:true})); app.get("/oauth/x/callback",(_,res)=>res.send("callback"));
  const server=await new Promise((resolve)=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});
  try { assert.equal((await request(server,"GET","/api/read")).status,200); assert.equal((await request(server,"POST","/api/write","{}")).status,503); assert.equal((await request(server,"GET","/oauth/x/callback")).status,503); }
  finally { await new Promise((resolve)=>server.close(resolve)); fs.rmSync(dir,{recursive:true,force:true}); }
});

test("guarded batch runner refuses to spawn while frozen", () => {
  const { main }=require("../scripts/writeFreezeGuardedRunner"); let spawned=0;
  assert.throws(()=>main(["scheduledPostRunner.js"],{freezeOptions:{existsSync:()=>true},spawnSync:()=>{spawned++;return{status:0};}}),/frozen/);
  assert.equal(spawned,0); assert.equal(main(["scheduledPostRunner.js"],{freezeOptions:{existsSync:()=>false},spawnSync:()=>{spawned++;return{status:0};}}),0); assert.equal(spawned,1);
});

test("Stripe webhook returns 503 without DB mutation during freeze, then retry is processed once", {timeout:30000}, async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"freeze-webhook-")), sentinel=path.join(dir,"freeze"), dbFile=path.join(dir,"db.sqlite3");
  const key=crypto.randomBytes(32).toString("base64"); Object.assign(process.env,{SNS_POSTER_DATA_SOURCE:"sqlite",SNS_POSTER_SQLITE_PATH:dbFile,SNS_POSTER_WRITE_FREEZE_PATH:sentinel,OAUTH_TOKEN_KEY_VERSION:"1",OAUTH_TOKEN_KEYS_JSON:JSON.stringify({1:key}),STRIPE_WEBHOOK_SECRET:"fixture-secret"});
  const db=openDatabase(dbFile); migrate(db); const now=new Date().toISOString(); db.prepare("INSERT INTO customers(id,slug,primary_email,status,plan,created_at,updated_at)VALUES('c1','c1','a@example.test','trial','basic',?,?)").run(now,now); db.close();
  const stripePath=require.resolve("./stripeClient"); require.cache[stripePath]={id:stripePath,filename:stripePath,loaded:true,exports:{getStripe:()=>({webhooks:{constructEvent:(body)=>JSON.parse(body.toString())}})}};
  const app=express(); app.use(writeFreezeMiddleware()); app.use(require("../routes/billing")); const server=await new Promise((resolve)=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});
  const event=JSON.stringify({id:"evt-freeze-1",type:"checkout.session.completed",data:{object:{client_reference_id:"c1",customer:"cus_fixture",subscription:"sub_fixture"}}});
  try {
    fs.writeFileSync(sentinel,""); assert.equal((await request(server,"POST","/api/billing/webhook",event)).status,503);
    const {getSqliteContext,closeSqliteContext}=require("../data/dataSource"); let ctx=getSqliteContext(); assert.equal(ctx.db.prepare("SELECT status FROM customers WHERE id='c1'").get().status,"trial"); assert.equal(ctx.db.prepare("SELECT count(*) n FROM stripe_webhook_events").get().n,0);
    fs.unlinkSync(sentinel); assert.equal((await request(server,"POST","/api/billing/webhook",event)).status,200); assert.equal((await request(server,"POST","/api/billing/webhook",event)).status,200);
    assert.equal(ctx.db.prepare("SELECT status FROM customers WHERE id='c1'").get().status,"active"); assert.equal(ctx.db.prepare("SELECT count(*) n FROM stripe_webhook_events WHERE state='done'").get().n,1); closeSqliteContext();
  } finally { await new Promise((resolve)=>server.close(resolve)); try{require("../data/dataSource").closeSqliteContext();}catch{} delete require.cache[stripePath]; fs.rmSync(dir,{recursive:true,force:true}); }
});
