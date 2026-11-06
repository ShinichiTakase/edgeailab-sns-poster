-- Refuse rollback while link URLs exist; never silently discard them.
CREATE TEMP TABLE link_url_rollback_guard(value INTEGER CHECK(value=0));
INSERT INTO link_url_rollback_guard SELECT COUNT(*) FROM schedule_texts WHERE link_url IS NOT NULL AND link_url<>'';
INSERT INTO link_url_rollback_guard SELECT COUNT(*) FROM scheduled_posts WHERE link_url IS NOT NULL AND link_url<>'';
DROP TABLE link_url_rollback_guard;
ALTER TABLE scheduled_posts DROP COLUMN link_url;
ALTER TABLE schedule_texts DROP COLUMN link_url;
