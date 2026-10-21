-- Additive: existing Facebook rows remain normal posts.
ALTER TABLE schedules ADD COLUMN facebook_reels INTEGER NOT NULL DEFAULT 0 CHECK(facebook_reels IN (0,1));
ALTER TABLE scheduled_posts ADD COLUMN post_kind TEXT NOT NULL DEFAULT 'normal' CHECK(post_kind IN ('normal','reel'));
ALTER TABLE posting_logs ADD COLUMN post_kind TEXT NOT NULL DEFAULT 'normal' CHECK(post_kind IN ('normal','reel'));
ALTER TABLE scheduled_post_jobs ADD COLUMN upload_stage TEXT;
ALTER TABLE scheduled_post_jobs ADD COLUMN publish_started_at TEXT;
ALTER TABLE scheduled_post_jobs ADD COLUMN publish_confirmed_at TEXT;
