const { contentHash } = require("./canonicalJson");
const { choice } = require("./inspectExport");

function countsBy(rows, keyFn) {
  const result = {};
  for (const row of rows) { const key = keyFn(row); result[key] = (result[key] || 0) + 1; }
  return result;
}
function ordered(value) { return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b))); }
function sqlCounts(db, sql) { return Object.fromEntries(db.prepare(sql).all().map((r) => [r.key, r.count])); }

function verifyShadow(db, bundle) {
  const m=bundle.microcms; const j=bundle.json;
  const tableNames=["customers","users","user_approvers","social_accounts","social_account_pages","social_account_history","oauth_states",
    "schedules","schedule_platforms","schedule_weekdays","schedule_slots","schedule_texts","schedule_text_variants","schedule_text_approvals",
    "scheduled_posts","scheduled_post_approvals","scheduled_post_jobs","scheduled_post_attempts","posting_logs","scheduled_post_effects",
    "billing_meter_events","notifications","notification_reads","x_surcharge_versions","stripe_webhook_events","audit_logs","migration_imports","migration_quarantine"];
  const tableCounts=Object.fromEntries(tableNames.map((name)=>[name,db.prepare(`SELECT count(*) count FROM ${name}`).get().count]));
  const endpointMap={customers:"customers",post_schedules:"schedules",schedule_texts:"schedule_texts",scheduled_posts:"scheduled_posts",posting_logs:"posting_logs"};
  const endpoints={};
  for(const [source,table] of Object.entries(endpointMap)){
    const sourceIds=m[source].map((r)=>String(r.id)).sort(); const targetIds=db.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map((r)=>String(r.id));
    endpoints[source]={sourceCount:sourceIds.length,targetCount:targetIds.length,idSetMatch:contentHash(sourceIds)===contentHash(targetIds)};
  }
  const sourcePlatform={scheduled_posts:ordered(countsBy(m.scheduled_posts,(r)=>choice(r.platform))),posting_logs:ordered(countsBy(m.posting_logs,(r)=>choice(r.platform)))};
  const targetPlatform={scheduled_posts:ordered(sqlCounts(db,"SELECT platform key,count(*) count FROM scheduled_posts GROUP BY platform")),
    posting_logs:ordered(sqlCounts(db,"SELECT platform key,count(*) count FROM posting_logs GROUP BY platform"))};
  const sourceStatus=ordered(countsBy(m.scheduled_posts,(r)=>choice(r.status)));
  const targetStatus=ordered(sqlCounts(db,"SELECT state key,count(*) count FROM scheduled_post_jobs GROUP BY state"));
  const sourceApproval={scheduled_posts:ordered(countsBy(m.scheduled_posts,(r)=>choice(r.approval_status)||"none")),
    schedule_texts:ordered(countsBy(m.schedule_texts,(r)=>choice(r.approval_status)||"none"))};
  const targetApproval={scheduled_posts:ordered(sqlCounts(db,"SELECT approval_state key,count(*) count FROM scheduled_posts GROUP BY approval_state")),
    schedule_texts:ordered(sqlCounts(db,"SELECT approval_state key,count(*) count FROM schedule_texts GROUP BY approval_state"))};
  const sourceCustomerPosting=ordered(countsBy(m.posting_logs,(r)=>r.customer_code));
  const targetCustomerPosting=ordered(sqlCounts(db,"SELECT customer_id key,count(*) count FROM posting_logs GROUP BY customer_id"));
  const sourceMonthly=ordered(countsBy(m.posting_logs,(r)=>r.billing_period));
  const targetMonthly=ordered(sqlCounts(db,"SELECT billing_period key,count(*) count FROM posting_logs GROUP BY billing_period"));
  const sourceBilling=ordered(countsBy(m.posting_logs,(r)=>`${r.billing_period}|${choice(r.platform)}|${r.contains_url?1:0}`));
  const targetBilling=ordered(sqlCounts(db,"SELECT billing_period||'|'||platform||'|'||contains_url key,count(*) count FROM posting_logs GROUP BY billing_period,platform,contains_url"));
  const tokenEntries=Object.values(j["client_tokens.json"]||{}).flatMap((platforms)=>Object.entries(platforms||{}));
  const sourceTokenValues=tokenEntries.reduce((n,[,entry])=>n+(entry.access_token?1:0)+(entry.refresh_token?1:0)+(entry.pages||[]).filter((p)=>p.pageAccessToken).length,0);
  const targetTokenValues=db.prepare(`SELECT (SELECT count(*) FROM social_accounts WHERE access_token_ciphertext IS NOT NULL)+
    (SELECT count(*) FROM social_accounts WHERE refresh_token_ciphertext IS NOT NULL)+
    (SELECT count(*) FROM social_account_pages WHERE access_token_ciphertext IS NOT NULL) count`).get().count;
  const stripeRefs={customerSource:m.customers.filter((c)=>c.stripeCustomerId).length,
    customerTarget:db.prepare("SELECT count(*) count FROM customers WHERE stripe_customer_id IS NOT NULL").get().count,
    subscriptionSource:m.customers.filter((c)=>c.stripeSubscriptionId).length,
    subscriptionTarget:db.prepare("SELECT count(*) count FROM customers WHERE stripe_subscription_id IS NOT NULL").get().count};
  const quarantine=ordered(sqlCounts(db,"SELECT reason key,count(*) count FROM migration_quarantine GROUP BY reason"));
  const checks={endpointCountsAndIds:Object.values(endpoints).every((x)=>x.sourceCount===x.targetCount&&x.idSetMatch),
    platformCounts:contentHash(sourcePlatform)===contentHash(targetPlatform),statusCounts:contentHash(sourceStatus)===contentHash(targetStatus),
    approvalCounts:contentHash(sourceApproval)===contentHash(targetApproval),customerPostingCounts:contentHash(sourceCustomerPosting)===contentHash(targetCustomerPosting),
    monthlyPostingCounts:contentHash(sourceMonthly)===contentHash(targetMonthly),billingUsageInputs:contentHash(sourceBilling)===contentHash(targetBilling),
    stripeReferences:stripeRefs.customerSource===stripeRefs.customerTarget&&stripeRefs.subscriptionSource===stripeRefs.subscriptionTarget,
    tokenValues:sourceTokenValues===targetTokenValues,
    notifications:(j["announcements.json"]||[]).length===tableCounts.notifications};
  return { tableCounts,endpoints,sourcePlatform,targetPlatform,sourceStatus,targetStatus,sourceApproval,targetApproval,
    customerPostingCountsMatch:checks.customerPostingCounts,monthlyPostingCounts:targetMonthly,billingUsageInputsMatch:checks.billingUsageInputs,
    stripeRefs,socialAccountSourceCount:tokenEntries.length,tokenValueSourceCount:sourceTokenValues,tokenValueTargetCount:targetTokenValues,
    notificationSourceCount:(j["announcements.json"]||[]).length,quarantine,checks,allChecksPass:Object.values(checks).every(Boolean),
    integrityCheck:db.pragma("integrity_check",{simple:true}),foreignKeyErrors:db.pragma("foreign_key_check").length};
}

module.exports = { verifyShadow };
