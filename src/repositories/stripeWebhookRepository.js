function createStripeWebhookRepository(db,{now=()=>new Date().toISOString()}={}){
 function begin({eventId,eventType}){const at=now();const existing=db.prepare("SELECT * FROM stripe_webhook_events WHERE stripe_event_id=?").get(eventId);if(existing?.state==="done"||existing?.state==="processing")return null;db.prepare(`INSERT INTO stripe_webhook_events(stripe_event_id,event_type,state,received_at,last_error)VALUES(?,?,'processing',?,NULL) ON CONFLICT(stripe_event_id)DO UPDATE SET state='processing',last_error=NULL`).run(eventId,eventType,at);return db.prepare("SELECT * FROM stripe_webhook_events WHERE stripe_event_id=?").get(eventId);}
 function finish(eventId,{state,error=null}){if(!["done","failed"].includes(state))throw new Error("invalid webhook state");return db.prepare("UPDATE stripe_webhook_events SET state=?,processed_at=?,last_error=? WHERE stripe_event_id=? AND state='processing'").run(state,now(),error,eventId).changes===1;}
 return{begin,finish};
}
module.exports={createStripeWebhookRepository};
