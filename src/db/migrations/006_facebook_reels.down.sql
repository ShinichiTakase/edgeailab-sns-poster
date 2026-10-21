-- Refuse rollback while reel records exist; never silently discard their history.
CREATE TEMP TABLE reels_rollback_guard(value INTEGER CHECK(value=0));
INSERT INTO reels_rollback_guard SELECT COUNT(*) FROM schedules WHERE facebook_reels=1;
INSERT INTO reels_rollback_guard SELECT COUNT(*) FROM scheduled_posts WHERE post_kind='reel';
INSERT INTO reels_rollback_guard SELECT COUNT(*) FROM posting_logs WHERE post_kind='reel';
DROP TABLE reels_rollback_guard;
ALTER TABLE scheduled_post_jobs DROP COLUMN publish_confirmed_at;
ALTER TABLE scheduled_post_jobs DROP COLUMN publish_started_at;
ALTER TABLE scheduled_post_jobs DROP COLUMN upload_stage;
ALTER TABLE posting_logs DROP COLUMN post_kind;
ALTER TABLE scheduled_posts DROP COLUMN post_kind;
ALTER TABLE schedules DROP COLUMN facebook_reels;
