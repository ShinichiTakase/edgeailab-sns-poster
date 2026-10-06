CREATE TABLE migration_runs (
  id TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL UNIQUE,
  source_exported_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','complete','failed')),
  report_json TEXT CHECK (report_json IS NULL OR json_valid(report_json))
);

CREATE TABLE migration_imports (
  source_type TEXT NOT NULL CHECK (source_type IN ('microcms','json')),
  source_name TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  target_table TEXT,
  target_id TEXT,
  migration_run_id TEXT NOT NULL REFERENCES migration_runs(id),
  imported_at TEXT NOT NULL,
  PRIMARY KEY(source_type, source_name, source_id)
);
CREATE INDEX migration_imports_target_idx ON migration_imports(target_table, target_id);

CREATE TABLE migration_quarantine (
  id INTEGER PRIMARY KEY,
  migration_run_id TEXT NOT NULL REFERENCES migration_runs(id),
  source_type TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_id_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  encryption_key_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source_type, source_name, source_id_hash, reason)
);

CREATE TABLE change_journal (
  sequence INTEGER PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('insert','update','delete')),
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  occurred_at TEXT NOT NULL,
  exported_at TEXT
);
CREATE INDEX change_journal_unexported_idx ON change_journal(exported_at, sequence);
