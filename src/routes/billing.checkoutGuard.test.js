const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const customerStore = require('../lib/customerStore');
const stripeClient = require('../lib/stripeClient');
const pricing = require('../lib/stripePricing');
const { signSession, COOKIE_NAME } = require('../lib/jwt');
let customer;
let checkoutCalls = 0;
let events = [];
customerStore.getCustomerById = async id => id === customer.id ? customer : null;
stripeClient.getStripe = () => ({ checkout: { sessions: { create: async args => {
  checkoutCalls++; assert.equal(args.customer,'cus_isolated');
  return {url:'https://checkout.stripe.test/isolated'};
}}}, webhooks: {constructEvent:()=>{throw new Error('invalid signature');}} });
stripeClient.ensureStripeCustomer = async () => {events.push('customer'); return 'cus_isolated';};
stripeClient.applyInvoiceRenderingTemplate = async () => {};
pricing.pricesForPlan = () => ({base:'price_base',metered:'price_usage',meteredX:'price_x'});
const billing = require('./billing');
let server,base;
test.before(async()=>{
 const app=express();app.use(billing);
 server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 base=`http://127.0.0.1:${server.address().port}`;
});
test.after(()=>new Promise(r=>server.close(r)));
test.beforeEach(()=>{
 checkoutCalls=0;events=[];
 customer={id:'cust_isolated',plan:['basic'],status:['trial'],users:[{userId:'u1',email:'test@example.com',role:['管理者'],sessionVersion:0}]};
});
function request(path, cookie, body='{}') {
 return new Promise((resolve,reject)=>{
  const req=http.request(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})}},res=>{
   let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:text}));
  });req.on('error',reject);req.end(body);
 });
}
function cookie(){return `${COOKIE_NAME}=${signSession(customer,customer.users[0])}`;}
test('Checkoutは管理者のみ、他ロールはStripe操作より前に拒否',async()=>{
 for(const role of ['閲覧者','編集者','承認者']){
  customer.users[0].role=[role];
  assert.equal((await request('/api/billing/create-checkout-session',cookie())).status,403);
 }
 assert.equal(checkoutCalls,0);assert.equal(events.length,0);
});
test('既存subscriptionのある顧客・解約済み顧客から新契約を作らない',async()=>{
 customer.stripeSubscriptionId='sub_existing';
 assert.equal((await request('/api/billing/create-checkout-session',cookie())).status,409);
 customer.stripeSubscriptionId=null;customer.status=['canceled'];
 assert.equal((await request('/api/billing/create-checkout-session',cookie())).status,403);
 assert.equal(checkoutCalls,0);assert.equal(events.length,0);
});
test('管理者の初回Checkoutは既存フローを維持',async()=>{
 const res=await request('/api/billing/create-checkout-session',cookie());
 assert.equal(res.status,200);assert.equal(checkoutCalls,1);
});
test('未認証・不正Cookie・改竄JWT・古いsessionVersionは401',async()=>{
 for(const token of [undefined,`${COOKIE_NAME}=%E0%A4%A`,`${COOKIE_NAME}=invalid`]){
  assert.equal((await request('/api/billing/create-checkout-session',token)).status,401);
 }
 const stale=cookie();customer.users[0].sessionVersion++;
 assert.equal((await request('/api/billing/create-checkout-session',stale)).status,401);
 assert.equal(checkoutCalls,0);
});
test('署名不正Webhookは400で課金処理に進まない',async()=>{
 process.env.STRIPE_WEBHOOK_SECRET='isolated-test-secret';
 const res=await request('/api/billing/webhook',undefined);
 assert.equal(res.status,400);assert.equal(checkoutCalls,0);
 delete process.env.STRIPE_WEBHOOK_SECRET;
});
