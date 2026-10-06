CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  primary_email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  company_name TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('trial','active','canceled')),
  plan TEXT NOT NULL CHECK (plan IN ('basic','standard','advanced')),
  is_verified INTEGER NOT NULL DEFAULT 0 CHECK (is_verified IN (0,1)),
  verification_token_hash TEXT UNIQUE,
  verification_expires_at TEXT,
  trial_ends_at TEXT,
  trial_post_count INTEGER NOT NULL DEFAULT 0 CHECK (trial_post_count >= 0),
  trial_limit_auto_activated_at TEXT,
  trial_reminder_sent_at TEXT,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  canceled_at TEXT,
  source_created_at TEXT,
  source_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
);
CREATE INDEX customers_status_trial_ends_idx ON customers(status, trial_ends_at);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('管理者','承認者','編集者','閲覧者')),
  is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0,1)),
  invited_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  invitation_status TEXT CHECK (invitation_status IS NULL OR invitation_status IN ('招待中','承諾済み','期限切れ','取消済み')),
  invitation_token_hash TEXT UNIQUE,
  invitation_expires_at TEXT,
  reset_token_hash TEXT UNIQUE,
  reset_expires_at TEXT,
  session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(customer_id, id)
);
CREATE UNIQUE INDEX users_one_owner_per_customer_idx ON users(customer_id) WHERE is_owner = 1;
CREATE INDEX users_customer_idx ON users(customer_id);

CREATE TABLE user_approvers (
  editor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approver_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(editor_user_id, approver_user_id),
  CHECK(editor_user_id <> approver_user_id)
);

CREATE TABLE social_accounts (
  id INTEGER PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('x','threads','facebook','instagram','linkedin')),
  external_account_id TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  access_token_ciphertext TEXT,
  refresh_token_ciphertext TEXT,
  encryption_key_version INTEGER CHECK (encryption_key_version IS NULL OR encryption_key_version > 0),
  token_expires_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disconnected_at TEXT,
  UNIQUE(platform, external_account_id)
);
CREATE INDEX social_accounts_customer_platform_idx ON social_accounts(customer_id, platform);

CREATE TABLE social_account_pages (
  id INTEGER PRIMARY KEY,
  social_account_id INTEGER NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  external_page_id TEXT NOT NULL,
  page_name TEXT NOT NULL DEFAULT '',
  access_token_ciphertext TEXT,
  encryption_key_version INTEGER CHECK (encryption_key_version IS NULL OR encryption_key_version > 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(social_account_id, external_page_id)
);

CREATE TABLE social_account_history (
  platform TEXT NOT NULL CHECK (platform IN ('x','threads','facebook','instagram','linkedin')),
  external_account_id TEXT NOT NULL,
  first_customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  first_connected_at TEXT NOT NULL,
  PRIMARY KEY(platform, external_account_id)
);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('x','threads','facebook','instagram','linkedin')),
  code_verifier_ciphertext TEXT,
  payload_ciphertext TEXT,
  encryption_key_version INTEGER NOT NULL CHECK (encryption_key_version > 0),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX oauth_states_expiry_idx ON oauth_states(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  source_created_by TEXT,
  name TEXT NOT NULL,
  url_mode INTEGER NOT NULL DEFAULT 0 CHECK (url_mode IN (0,1)),
  notify_email INTEGER NOT NULL DEFAULT 1 CHECK (notify_email IN (0,1)),
  start_date TEXT NOT NULL,
  end_date TEXT,
  daily_post_count INTEGER NOT NULL CHECK (daily_post_count BETWEEN 1 AND 3),
  is_paused INTEGER NOT NULL DEFAULT 0 CHECK (is_paused IN (0,1)),
  auto_paused INTEGER NOT NULL DEFAULT 0 CHECK (auto_paused IN (0,1)),
  round_robin_index INTEGER NOT NULL DEFAULT 0 CHECK (round_robin_index >= 0),
  facebook_page_id TEXT,
  last_materialized_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX schedules_customer_active_idx ON schedules(customer_id, is_paused, auto_paused);
CREATE INDEX schedules_materialize_idx ON schedules(last_materialized_date, is_paused, auto_paused);

CREATE TABLE schedule_platforms (
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('x','threads','facebook','instagram','linkedin')),
  PRIMARY KEY(schedule_id, platform)
);
CREATE TABLE schedule_weekdays (
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  PRIMARY KEY(schedule_id, weekday)
);
CREATE TABLE schedule_slots (
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 3),
  start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute INTEGER NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  PRIMARY KEY(schedule_id, position),
  CHECK(start_minute < end_minute)
);

CREATE TABLE schedule_texts (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  source_created_by TEXT,
  source_excerpt TEXT NOT NULL DEFAULT '',
  batch_id TEXT,
  approval_state TEXT NOT NULL DEFAULT 'none' CHECK (approval_state IN ('none','pending','approved','rejected','expired')),
  approval_requested_at TEXT,
  approval_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX schedule_texts_schedule_created_idx ON schedule_texts(schedule_id, created_at);
CREATE INDEX schedule_texts_approval_batch_idx ON schedule_texts(batch_id, approval_state);

CREATE TABLE schedule_text_variants (
  schedule_text_id TEXT NOT NULL REFERENCES schedule_texts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('x','threads','facebook','instagram','linkedin')),
  content TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  video_url TEXT,
  PRIMARY KEY(schedule_text_id, platform)
);

CREATE TABLE schedule_text_approvals (
  schedule_text_id TEXT NOT NULL REFERENCES schedule_texts(id) ON DELETE CASCADE,
  approver_user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','expired')),
  token_expires_at TEXT NOT NULL,
  responded_at TEXT,
  comment TEXT,
  PRIMARY KEY(schedule_text_id, approver_user_id)
);

CREATE TABLE scheduled_posts (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  source_created_by TEXT,
  source_schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL,
  source_schedule_id_raw TEXT,
  materialization_key TEXT UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('x','threads','facebook','instagram','linkedin')),
  content TEXT NOT NULL DEFAULT '',
  scheduled_at TEXT NOT NULL,
  contains_url INTEGER NOT NULL DEFAULT 0 CHECK (contains_url IN (0,1)),
  image_url TEXT,
  video_url TEXT,
  facebook_page_id TEXT,
  notify_email INTEGER CHECK (notify_email IS NULL OR notify_email IN (0,1)),
  lifecycle_state TEXT NOT NULL DEFAULT 'scheduled' CHECK (lifecycle_state IN ('scheduled','canceled')),
  batch_id TEXT,
  approval_state TEXT NOT NULL DEFAULT 'none' CHECK (approval_state IN ('none','pending','approved','rejected','expired')),
  approval_requested_at TEXT,
  approval_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX scheduled_posts_customer_time_idx ON scheduled_posts(customer_id, scheduled_at);
CREATE INDEX scheduled_posts_source_state_idx ON scheduled_posts(source_schedule_id, lifecycle_state);
CREATE INDEX scheduled_posts_approval_idx ON scheduled_posts(approval_state, scheduled_at);

CREATE TABLE scheduled_post_approvals (
  scheduled_post_id TEXT NOT NULL REFERENCES scheduled_posts(id) ON DELETE CASCADE,
  approver_user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','expired')),
  token_expires_at TEXT NOT NULL,
  responded_at TEXT,
  comment TEXT,
  PRIMARY KEY(scheduled_post_id, approver_user_id)
);

CREATE TABLE scheduled_post_jobs (
  scheduled_post_id TEXT PRIMARY KEY REFERENCES scheduled_posts(id) ON DELETE CASCADE,
  execution_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','sent','done','ambiguous','failed','canceled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  current_attempt_id TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  next_attempt_at TEXT,
  request_started_at TEXT,
  external_container_id TEXT,
  external_post_id TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK ((state = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND current_attempt_id IS NOT NULL)
      OR state <> 'processing')
);
CREATE INDEX scheduled_post_jobs_claim_idx ON scheduled_post_jobs(state, next_attempt_at, lease_expires_at);
CREATE INDEX scheduled_post_jobs_external_post_idx ON scheduled_post_jobs(external_post_id) WHERE external_post_id IS NOT NULL;

CREATE TABLE scheduled_post_attempts (
  id TEXT PRIMARY KEY,
  scheduled_post_id TEXT NOT NULL REFERENCES scheduled_posts(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  worker_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  request_started_at TEXT,
  finished_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('sent','failed','ambiguous')),
  external_request_id TEXT,
  external_container_id TEXT,
  external_post_id TEXT,
  error_code TEXT,
  error_message TEXT,
  UNIQUE(scheduled_post_id, attempt_no)
);

CREATE TABLE posting_logs (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  source_created_by TEXT,
  scheduled_post_id TEXT REFERENCES scheduled_posts(id) ON DELETE SET NULL,
  platform TEXT NOT NULL CHECK (platform IN ('x','threads','facebook','instagram','linkedin')),
  content TEXT NOT NULL DEFAULT '',
  external_post_id TEXT,
  account_name TEXT NOT NULL DEFAULT '',
  posted_at TEXT NOT NULL,
  billing_period TEXT NOT NULL CHECK (billing_period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  contains_url INTEGER NOT NULL DEFAULT 0 CHECK (contains_url IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX posting_logs_scheduled_post_idx ON posting_logs(scheduled_post_id) WHERE scheduled_post_id IS NOT NULL;
CREATE UNIQUE INDEX posting_logs_external_post_idx ON posting_logs(platform, external_post_id) WHERE external_post_id IS NOT NULL;
CREATE INDEX posting_logs_customer_period_idx ON posting_logs(customer_id, billing_period);

CREATE TABLE scheduled_post_effects (
  id INTEGER PRIMARY KEY,
  scheduled_post_id TEXT NOT NULL REFERENCES scheduled_posts(id) ON DELETE CASCADE,
  effect_type TEXT NOT NULL CHECK (effect_type IN ('posting_log','trial_post_count','stripe_meter','email','notification')),
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','done','ambiguous','failed','skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at TEXT,
  next_attempt_at TEXT,
  external_reference TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(scheduled_post_id, effect_type)
);
CREATE INDEX scheduled_post_effects_work_idx ON scheduled_post_effects(state, next_attempt_at);

CREATE TABLE billing_meter_events (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  posting_log_id TEXT REFERENCES posting_logs(id) ON DELETE SET NULL,
  scheduled_post_id TEXT REFERENCES scheduled_posts(id) ON DELETE SET NULL,
  event_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','done','ambiguous','failed','skipped')),
  stripe_event_identifier TEXT UNIQUE,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at TEXT,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX billing_meter_events_work_idx ON billing_meter_events(state, next_attempt_at);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  platform TEXT CHECK (platform IS NULL OR platform IN ('x','threads','facebook','instagram','linkedin')),
  related_entity_type TEXT,
  related_entity_id TEXT,
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX notifications_customer_created_idx ON notifications(customer_id, created_at);

CREATE TABLE notification_reads (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TEXT NOT NULL
);

CREATE TABLE x_surcharge_versions (
  id INTEGER PRIMARY KEY,
  amount INTEGER CHECK (amount IS NULL OR amount >= 0),
  reference_usd REAL CHECK (reference_usd IS NULL OR reference_usd >= 0),
  reference_usd_updated_at TEXT,
  effective_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('scheduled','active','superseded','canceled','reference')),
  stripe_prices_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(stripe_prices_json)),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
  ,CHECK ((state = 'reference' AND reference_usd IS NOT NULL) OR (state <> 'reference' AND amount IS NOT NULL))
);
CREATE UNIQUE INDEX x_surcharge_one_active_idx ON x_surcharge_versions(state) WHERE state = 'active';
CREATE INDEX x_surcharge_effective_idx ON x_surcharge_versions(state, effective_at);

CREATE TABLE stripe_webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'processing' CHECK (state IN ('processing','done','failed')),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  last_error TEXT
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','admin','system','migration')),
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  request_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_logs_entity_idx ON audit_logs(entity_type, entity_id, created_at);
CREATE INDEX audit_logs_customer_idx ON audit_logs(customer_id, created_at);
