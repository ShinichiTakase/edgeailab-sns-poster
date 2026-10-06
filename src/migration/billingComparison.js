const path=require("path");
require("dotenv").config({path:path.join(__dirname,"..","..",".env")});
const Stripe=require("stripe");
const {openDatabase}=require("../db/connection");
const {loadExport}=require("./inspectExport");
const {pricesForPlan}=require("../lib/stripePricing");
const {computePriceAmount}=require("../lib/stripeTierPricing");

const PLATFORMS=["x","threads","facebook","instagram","linkedin"];
function empty(){return Object.fromEntries(PLATFORMS.map((p)=>[p,0]));}
async function compute(db,cache,stripe){
  const posts={counts:empty(),total:0};const revenue={counts:empty(),total:0,xSurcharge:0,baseFee:0};
  const priceCache=new Map();
  async function price(plan){if(!priceCache.has(plan)){const ids=pricesForPlan(plan);priceCache.set(plan,Promise.all([
    stripe.prices.retrieve(ids.metered,{expand:["tiers"]}),stripe.prices.retrieve(ids.meteredX,{expand:["tiers"]}),stripe.prices.retrieve(ids.base)]));}return priceCache.get(plan);}
  const customers=db.prepare("SELECT id,status,plan FROM customers").all();
  for(const customer of customers){
    const rows=db.prepare(`SELECT platform,contains_url,count(*) count FROM posting_logs WHERE customer_id=? AND billing_period=?
      AND posted_at<=? GROUP BY platform,contains_url`).all(customer.id,cache.month,cache.generatedAt);
    const counts=empty();let total=0,xUrls=0;for(const row of rows){counts[row.platform]+=row.count;total+=row.count;if(row.platform==="x"&&row.contains_url)xUrls+=row.count;}
    for(const platform of PLATFORMS)posts.counts[platform]+=counts[platform];posts.total+=total;
    if(customer.status!=="active")continue;const [metered,meteredX,base]=await price(customer.plan);revenue.baseFee+=base.unit_amount||0;
    const meteredAmount=computePriceAmount(metered,total);revenue.total+=meteredAmount;revenue.xSurcharge+=computePriceAmount(meteredX,xUrls);
    if(total)for(const platform of PLATFORMS)revenue.counts[platform]+=meteredAmount*(counts[platform]/total);
  }
  for(const platform of PLATFORMS)revenue.counts[platform]=Math.round(revenue.counts[platform]);
  revenue.total=Math.round(revenue.total);revenue.xSurcharge=Math.round(revenue.xSurcharge);revenue.baseFee=Math.round(revenue.baseFee);
  return {posts,revenue};
}
async function compareBilling({databasePath,exportDirectory}){
  const bundle=loadExport(exportDirectory);const db=openDatabase(databasePath,{readonly:true});const stripe=new Stripe(process.env.STRIPE_SECRET_KEY);
  try{const output={};for(const [label,name] of [["lastMonth","admin_stats_last_month.json"],["thisMonth","admin_stats_this_month.json"]]){
    const cache=bundle.json[name];const calculated=await compute(db,cache,stripe);output[label]={month:cache.month,
      postCountsMatch:JSON.stringify(calculated.posts)===JSON.stringify(cache.posts),revenueMatch:JSON.stringify(calculated.revenue)===JSON.stringify(cache.revenue),
      source:cache.revenue,sqlite:calculated.revenue};}return output;}finally{db.close();}
}
if(require.main===module){const get=(n)=>{const i=process.argv.indexOf(n);if(i<0)throw new Error(`${n} required`);return process.argv[i+1]};
  compareBilling({databasePath:get("--database"),exportDirectory:get("--export")}).then((result)=>console.log(JSON.stringify(result))).catch((e)=>{console.error(e.message);process.exitCode=1});}
module.exports={compareBilling};
