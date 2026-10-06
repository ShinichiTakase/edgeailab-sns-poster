function shouldNotifyForScheduledPost(post) {
  if (post.source_schedule_id) return Boolean(post.schedule_notify_email);
  // Legacy one-shot records had no notify_email field and were treated as enabled.
  return post.notify_email == null ? true : Boolean(post.notify_email);
}
module.exports = { shouldNotifyForScheduledPost };
