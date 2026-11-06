-- Additive: URL written to the reel comment / Threads reply (see docs/内部仕様_リンクコメント.md).
ALTER TABLE schedule_texts ADD COLUMN link_url TEXT;
ALTER TABLE scheduled_posts ADD COLUMN link_url TEXT;
