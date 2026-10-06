CREATE TABLE admin_stats_cache (
  stats_type TEXT PRIMARY KEY CHECK (stats_type IN ('this_month','last_month')),
  period TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  calculated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX admin_stats_cache_period_idx ON admin_stats_cache(period);
