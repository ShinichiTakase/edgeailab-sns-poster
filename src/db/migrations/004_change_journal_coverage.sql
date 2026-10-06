CREATE TRIGGER journal_customers_insert AFTER INSERT ON customers
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'customers',COALESCE(CAST(NEW.id AS TEXT),''),'insert',NULL,json_object('id',NEW.id,'slug',NEW.slug,'primary_email',NEW.primary_email,'company_name',NEW.company_name,'contact_name',NEW.contact_name,'status',NEW.status,'plan',NEW.plan,'is_verified',NEW.is_verified,'trial_ends_at',NEW.trial_ends_at,'trial_post_count',NEW.trial_post_count,'stripe_customer_id',NEW.stripe_customer_id,'stripe_subscription_id',NEW.stripe_subscription_id,'canceled_at',NEW.canceled_at,'updated_at',NEW.updated_at,'version',NEW.version),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_customers_update AFTER UPDATE ON customers
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'customers',COALESCE(CAST(NEW.id AS TEXT),''),'update',json_object('id',OLD.id,'slug',OLD.slug,'primary_email',OLD.primary_email,'company_name',OLD.company_name,'contact_name',OLD.contact_name,'status',OLD.status,'plan',OLD.plan,'is_verified',OLD.is_verified,'trial_ends_at',OLD.trial_ends_at,'trial_post_count',OLD.trial_post_count,'stripe_customer_id',OLD.stripe_customer_id,'stripe_subscription_id',OLD.stripe_subscription_id,'canceled_at',OLD.canceled_at,'updated_at',OLD.updated_at,'version',OLD.version),json_object('id',NEW.id,'slug',NEW.slug,'primary_email',NEW.primary_email,'company_name',NEW.company_name,'contact_name',NEW.contact_name,'status',NEW.status,'plan',NEW.plan,'is_verified',NEW.is_verified,'trial_ends_at',NEW.trial_ends_at,'trial_post_count',NEW.trial_post_count,'stripe_customer_id',NEW.stripe_customer_id,'stripe_subscription_id',NEW.stripe_subscription_id,'canceled_at',NEW.canceled_at,'updated_at',NEW.updated_at,'version',NEW.version),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_customers_delete AFTER DELETE ON customers
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'customers',COALESCE(CAST(OLD.id AS TEXT),''),'delete',json_object('id',OLD.id,'slug',OLD.slug,'primary_email',OLD.primary_email,'company_name',OLD.company_name,'contact_name',OLD.contact_name,'status',OLD.status,'plan',OLD.plan,'is_verified',OLD.is_verified,'trial_ends_at',OLD.trial_ends_at,'trial_post_count',OLD.trial_post_count,'stripe_customer_id',OLD.stripe_customer_id,'stripe_subscription_id',OLD.stripe_subscription_id,'canceled_at',OLD.canceled_at,'updated_at',OLD.updated_at,'version',OLD.version),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_users_insert AFTER INSERT ON users
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'users',COALESCE(CAST(NEW.id AS TEXT),''),'insert',NULL,json_object('id',NEW.id,'customer_id',NEW.customer_id,'email',NEW.email,'name',NEW.name,'role',NEW.role,'is_owner',NEW.is_owner,'invited_by_user_id',NEW.invited_by_user_id,'invitation_status',NEW.invitation_status,'session_version',NEW.session_version,'updated_at',NEW.updated_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_users_update AFTER UPDATE ON users
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'users',COALESCE(CAST(NEW.id AS TEXT),''),'update',json_object('id',OLD.id,'customer_id',OLD.customer_id,'email',OLD.email,'name',OLD.name,'role',OLD.role,'is_owner',OLD.is_owner,'invited_by_user_id',OLD.invited_by_user_id,'invitation_status',OLD.invitation_status,'session_version',OLD.session_version,'updated_at',OLD.updated_at),json_object('id',NEW.id,'customer_id',NEW.customer_id,'email',NEW.email,'name',NEW.name,'role',NEW.role,'is_owner',NEW.is_owner,'invited_by_user_id',NEW.invited_by_user_id,'invitation_status',NEW.invitation_status,'session_version',NEW.session_version,'updated_at',NEW.updated_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_users_delete AFTER DELETE ON users
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'users',COALESCE(CAST(OLD.id AS TEXT),''),'delete',json_object('id',OLD.id,'customer_id',OLD.customer_id,'email',OLD.email,'name',OLD.name,'role',OLD.role,'is_owner',OLD.is_owner,'invited_by_user_id',OLD.invited_by_user_id,'invitation_status',OLD.invitation_status,'session_version',OLD.session_version,'updated_at',OLD.updated_at),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_user_approvers_insert AFTER INSERT ON user_approvers
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'user_approvers',COALESCE(CAST(NEW.editor_user_id AS TEXT),'') || ':' || COALESCE(CAST(NEW.approver_user_id AS TEXT),''),'insert',NULL,json_object('editor_user_id',NEW.editor_user_id,'approver_user_id',NEW.approver_user_id,'created_at',NEW.created_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_user_approvers_update AFTER UPDATE ON user_approvers
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'user_approvers',COALESCE(CAST(NEW.editor_user_id AS TEXT),'') || ':' || COALESCE(CAST(NEW.approver_user_id AS TEXT),''),'update',json_object('editor_user_id',OLD.editor_user_id,'approver_user_id',OLD.approver_user_id,'created_at',OLD.created_at),json_object('editor_user_id',NEW.editor_user_id,'approver_user_id',NEW.approver_user_id,'created_at',NEW.created_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_user_approvers_delete AFTER DELETE ON user_approvers
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'user_approvers',COALESCE(CAST(OLD.editor_user_id AS TEXT),'') || ':' || COALESCE(CAST(OLD.approver_user_id AS TEXT),''),'delete',json_object('editor_user_id',OLD.editor_user_id,'approver_user_id',OLD.approver_user_id,'created_at',OLD.created_at),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_social_accounts_insert AFTER INSERT ON social_accounts
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'social_accounts',COALESCE(CAST(NEW.id AS TEXT),''),'insert',NULL,json_object('id',NEW.id,'customer_id',NEW.customer_id,'platform',NEW.platform,'external_account_id',NEW.external_account_id,'username',NEW.username,'encryption_key_version',NEW.encryption_key_version,'token_expires_at',NEW.token_expires_at,'connected_at',NEW.connected_at,'updated_at',NEW.updated_at,'disconnected_at',NEW.disconnected_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_social_accounts_update AFTER UPDATE ON social_accounts
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'social_accounts',COALESCE(CAST(NEW.id AS TEXT),''),'update',json_object('id',OLD.id,'customer_id',OLD.customer_id,'platform',OLD.platform,'external_account_id',OLD.external_account_id,'username',OLD.username,'encryption_key_version',OLD.encryption_key_version,'token_expires_at',OLD.token_expires_at,'connected_at',OLD.connected_at,'updated_at',OLD.updated_at,'disconnected_at',OLD.disconnected_at),json_object('id',NEW.id,'customer_id',NEW.customer_id,'platform',NEW.platform,'external_account_id',NEW.external_account_id,'username',NEW.username,'encryption_key_version',NEW.encryption_key_version,'token_expires_at',NEW.token_expires_at,'connected_at',NEW.connected_at,'updated_at',NEW.updated_at,'disconnected_at',NEW.disconnected_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_social_accounts_delete AFTER DELETE ON social_accounts
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'social_accounts',COALESCE(CAST(OLD.id AS TEXT),''),'delete',json_object('id',OLD.id,'customer_id',OLD.customer_id,'platform',OLD.platform,'external_account_id',OLD.external_account_id,'username',OLD.username,'encryption_key_version',OLD.encryption_key_version,'token_expires_at',OLD.token_expires_at,'connected_at',OLD.connected_at,'updated_at',OLD.updated_at,'disconnected_at',OLD.disconnected_at),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_social_account_pages_insert AFTER INSERT ON social_account_pages
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'social_account_pages',COALESCE(CAST(NEW.id AS TEXT),''),'insert',NULL,json_object('id',NEW.id,'social_account_id',NEW.social_account_id,'external_page_id',NEW.external_page_id,'page_name',NEW.page_name,'encryption_key_version',NEW.encryption_key_version,'created_at',NEW.created_at,'updated_at',NEW.updated_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_social_account_pages_update AFTER UPDATE ON social_account_pages
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'social_account_pages',COALESCE(CAST(NEW.id AS TEXT),''),'update',json_object('id',OLD.id,'social_account_id',OLD.social_account_id,'external_page_id',OLD.external_page_id,'page_name',OLD.page_name,'encryption_key_version',OLD.encryption_key_version,'created_at',OLD.created_at,'updated_at',OLD.updated_at),json_object('id',NEW.id,'social_account_id',NEW.social_account_id,'external_page_id',NEW.external_page_id,'page_name',NEW.page_name,'encryption_key_version',NEW.encryption_key_version,'created_at',NEW.created_at,'updated_at',NEW.updated_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_social_account_pages_delete AFTER DELETE ON social_account_pages
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'social_account_pages',COALESCE(CAST(OLD.id AS TEXT),''),'delete',json_object('id',OLD.id,'social_account_id',OLD.social_account_id,'external_page_id',OLD.external_page_id,'page_name',OLD.page_name,'encryption_key_version',OLD.encryption_key_version,'created_at',OLD.created_at,'updated_at',OLD.updated_at),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_social_account_history_insert AFTER INSERT ON social_account_history
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'social_account_history',COALESCE(CAST(NEW.platform AS TEXT),'') || ':' || COALESCE(CAST(NEW.external_account_id AS TEXT),''),'insert',NULL,json_object('platform',NEW.platform,'external_account_id',NEW.external_account_id,'first_customer_id',NEW.first_customer_id,'first_connected_at',NEW.first_connected_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_social_account_history_update AFTER UPDATE ON social_account_history
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'social_account_history',COALESCE(CAST(NEW.platform AS TEXT),'') || ':' || COALESCE(CAST(NEW.external_account_id AS TEXT),''),'update',json_object('platform',OLD.platform,'external_account_id',OLD.external_account_id,'first_customer_id',OLD.first_customer_id,'first_connected_at',OLD.first_connected_at),json_object('platform',NEW.platform,'external_account_id',NEW.external_account_id,'first_customer_id',NEW.first_customer_id,'first_connected_at',NEW.first_connected_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_social_account_history_delete AFTER DELETE ON social_account_history
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'social_account_history',COALESCE(CAST(OLD.platform AS TEXT),'') || ':' || COALESCE(CAST(OLD.external_account_id AS TEXT),''),'delete',json_object('platform',OLD.platform,'external_account_id',OLD.external_account_id,'first_customer_id',OLD.first_customer_id,'first_connected_at',OLD.first_connected_at),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedules_insert AFTER INSERT ON schedules
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedules',COALESCE(CAST(NEW.id AS TEXT),''),'insert',NULL,json_object('id',NEW.id,'customer_id',NEW.customer_id,'created_by_user_id',NEW.created_by_user_id,'name',NEW.name,'url_mode',NEW.url_mode,'notify_email',NEW.notify_email,'start_date',NEW.start_date,'end_date',NEW.end_date,'daily_post_count',NEW.daily_post_count,'is_paused',NEW.is_paused,'auto_paused',NEW.auto_paused,'round_robin_index',NEW.round_robin_index,'facebook_page_id',NEW.facebook_page_id,'last_materialized_date',NEW.last_materialized_date,'updated_at',NEW.updated_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedules_update AFTER UPDATE ON schedules
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedules',COALESCE(CAST(NEW.id AS TEXT),''),'update',json_object('id',OLD.id,'customer_id',OLD.customer_id,'created_by_user_id',OLD.created_by_user_id,'name',OLD.name,'url_mode',OLD.url_mode,'notify_email',OLD.notify_email,'start_date',OLD.start_date,'end_date',OLD.end_date,'daily_post_count',OLD.daily_post_count,'is_paused',OLD.is_paused,'auto_paused',OLD.auto_paused,'round_robin_index',OLD.round_robin_index,'facebook_page_id',OLD.facebook_page_id,'last_materialized_date',OLD.last_materialized_date,'updated_at',OLD.updated_at),json_object('id',NEW.id,'customer_id',NEW.customer_id,'created_by_user_id',NEW.created_by_user_id,'name',NEW.name,'url_mode',NEW.url_mode,'notify_email',NEW.notify_email,'start_date',NEW.start_date,'end_date',NEW.end_date,'daily_post_count',NEW.daily_post_count,'is_paused',NEW.is_paused,'auto_paused',NEW.auto_paused,'round_robin_index',NEW.round_robin_index,'facebook_page_id',NEW.facebook_page_id,'last_materialized_date',NEW.last_materialized_date,'updated_at',NEW.updated_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedules_delete AFTER DELETE ON schedules
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedules',COALESCE(CAST(OLD.id AS TEXT),''),'delete',json_object('id',OLD.id,'customer_id',OLD.customer_id,'created_by_user_id',OLD.created_by_user_id,'name',OLD.name,'url_mode',OLD.url_mode,'notify_email',OLD.notify_email,'start_date',OLD.start_date,'end_date',OLD.end_date,'daily_post_count',OLD.daily_post_count,'is_paused',OLD.is_paused,'auto_paused',OLD.auto_paused,'round_robin_index',OLD.round_robin_index,'facebook_page_id',OLD.facebook_page_id,'last_materialized_date',OLD.last_materialized_date,'updated_at',OLD.updated_at),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedule_platforms_insert AFTER INSERT ON schedule_platforms
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedule_platforms',COALESCE(CAST(NEW.schedule_id AS TEXT),'') || ':' || COALESCE(CAST(NEW.platform AS TEXT),''),'insert',NULL,json_object('schedule_id',NEW.schedule_id,'platform',NEW.platform),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedule_platforms_update AFTER UPDATE ON schedule_platforms
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedule_platforms',COALESCE(CAST(NEW.schedule_id AS TEXT),'') || ':' || COALESCE(CAST(NEW.platform AS TEXT),''),'update',json_object('schedule_id',OLD.schedule_id,'platform',OLD.platform),json_object('schedule_id',NEW.schedule_id,'platform',NEW.platform),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedule_platforms_delete AFTER DELETE ON schedule_platforms
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedule_platforms',COALESCE(CAST(OLD.schedule_id AS TEXT),'') || ':' || COALESCE(CAST(OLD.platform AS TEXT),''),'delete',json_object('schedule_id',OLD.schedule_id,'platform',OLD.platform),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedule_weekdays_insert AFTER INSERT ON schedule_weekdays
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedule_weekdays',COALESCE(CAST(NEW.schedule_id AS TEXT),'') || ':' || COALESCE(CAST(NEW.weekday AS TEXT),''),'insert',NULL,json_object('schedule_id',NEW.schedule_id,'weekday',NEW.weekday),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedule_weekdays_update AFTER UPDATE ON schedule_weekdays
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedule_weekdays',COALESCE(CAST(NEW.schedule_id AS TEXT),'') || ':' || COALESCE(CAST(NEW.weekday AS TEXT),''),'update',json_object('schedule_id',OLD.schedule_id,'weekday',OLD.weekday),json_object('schedule_id',NEW.schedule_id,'weekday',NEW.weekday),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedule_weekdays_delete AFTER DELETE ON schedule_weekdays
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedule_weekdays',COALESCE(CAST(OLD.schedule_id AS TEXT),'') || ':' || COALESCE(CAST(OLD.weekday AS TEXT),''),'delete',json_object('schedule_id',OLD.schedule_id,'weekday',OLD.weekday),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedule_slots_insert AFTER INSERT ON schedule_slots
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedule_slots',COALESCE(CAST(NEW.schedule_id AS TEXT),'') || ':' || COALESCE(CAST(NEW.position AS TEXT),''),'insert',NULL,json_object('schedule_id',NEW.schedule_id,'position',NEW.position,'start_minute',NEW.start_minute,'end_minute',NEW.end_minute),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedule_slots_update AFTER UPDATE ON schedule_slots
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedule_slots',COALESCE(CAST(NEW.schedule_id AS TEXT),'') || ':' || COALESCE(CAST(NEW.position AS TEXT),''),'update',json_object('schedule_id',OLD.schedule_id,'position',OLD.position,'start_minute',OLD.start_minute,'end_minute',OLD.end_minute),json_object('schedule_id',NEW.schedule_id,'position',NEW.position,'start_minute',NEW.start_minute,'end_minute',NEW.end_minute),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedule_slots_delete AFTER DELETE ON schedule_slots
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedule_slots',COALESCE(CAST(OLD.schedule_id AS TEXT),'') || ':' || COALESCE(CAST(OLD.position AS TEXT),''),'delete',json_object('schedule_id',OLD.schedule_id,'position',OLD.position,'start_minute',OLD.start_minute,'end_minute',OLD.end_minute),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedule_texts_insert AFTER INSERT ON schedule_texts
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedule_texts',COALESCE(CAST(NEW.id AS TEXT),''),'insert',NULL,json_object('id',NEW.id,'schedule_id',NEW.schedule_id,'created_by_user_id',NEW.created_by_user_id,'source_excerpt',NEW.source_excerpt,'batch_id',NEW.batch_id,'approval_state',NEW.approval_state,'approval_requested_at',NEW.approval_requested_at,'approval_expires_at',NEW.approval_expires_at,'updated_at',NEW.updated_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedule_texts_update AFTER UPDATE ON schedule_texts
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedule_texts',COALESCE(CAST(NEW.id AS TEXT),''),'update',json_object('id',OLD.id,'schedule_id',OLD.schedule_id,'created_by_user_id',OLD.created_by_user_id,'source_excerpt',OLD.source_excerpt,'batch_id',OLD.batch_id,'approval_state',OLD.approval_state,'approval_requested_at',OLD.approval_requested_at,'approval_expires_at',OLD.approval_expires_at,'updated_at',OLD.updated_at),json_object('id',NEW.id,'schedule_id',NEW.schedule_id,'created_by_user_id',NEW.created_by_user_id,'source_excerpt',NEW.source_excerpt,'batch_id',NEW.batch_id,'approval_state',NEW.approval_state,'approval_requested_at',NEW.approval_requested_at,'approval_expires_at',NEW.approval_expires_at,'updated_at',NEW.updated_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedule_texts_delete AFTER DELETE ON schedule_texts
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedule_texts',COALESCE(CAST(OLD.id AS TEXT),''),'delete',json_object('id',OLD.id,'schedule_id',OLD.schedule_id,'created_by_user_id',OLD.created_by_user_id,'source_excerpt',OLD.source_excerpt,'batch_id',OLD.batch_id,'approval_state',OLD.approval_state,'approval_requested_at',OLD.approval_requested_at,'approval_expires_at',OLD.approval_expires_at,'updated_at',OLD.updated_at),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedule_text_variants_insert AFTER INSERT ON schedule_text_variants
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedule_text_variants',COALESCE(CAST(NEW.schedule_text_id AS TEXT),'') || ':' || COALESCE(CAST(NEW.platform AS TEXT),''),'insert',NULL,json_object('schedule_text_id',NEW.schedule_text_id,'platform',NEW.platform,'content',NEW.content,'image_url',NEW.image_url,'video_url',NEW.video_url),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedule_text_variants_update AFTER UPDATE ON schedule_text_variants
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedule_text_variants',COALESCE(CAST(NEW.schedule_text_id AS TEXT),'') || ':' || COALESCE(CAST(NEW.platform AS TEXT),''),'update',json_object('schedule_text_id',OLD.schedule_text_id,'platform',OLD.platform,'content',OLD.content,'image_url',OLD.image_url,'video_url',OLD.video_url),json_object('schedule_text_id',NEW.schedule_text_id,'platform',NEW.platform,'content',NEW.content,'image_url',NEW.image_url,'video_url',NEW.video_url),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedule_text_variants_delete AFTER DELETE ON schedule_text_variants
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedule_text_variants',COALESCE(CAST(OLD.schedule_text_id AS TEXT),'') || ':' || COALESCE(CAST(OLD.platform AS TEXT),''),'delete',json_object('schedule_text_id',OLD.schedule_text_id,'platform',OLD.platform,'content',OLD.content,'image_url',OLD.image_url,'video_url',OLD.video_url),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedule_text_approvals_insert AFTER INSERT ON schedule_text_approvals
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedule_text_approvals',COALESCE(CAST(NEW.schedule_text_id AS TEXT),'') || ':' || COALESCE(CAST(NEW.approver_user_id AS TEXT),''),'insert',NULL,json_object('schedule_text_id',NEW.schedule_text_id,'approver_user_id',NEW.approver_user_id,'state',NEW.state,'token_expires_at',NEW.token_expires_at,'responded_at',NEW.responded_at,'comment',NEW.comment),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedule_text_approvals_update AFTER UPDATE ON schedule_text_approvals
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedule_text_approvals',COALESCE(CAST(NEW.schedule_text_id AS TEXT),'') || ':' || COALESCE(CAST(NEW.approver_user_id AS TEXT),''),'update',json_object('schedule_text_id',OLD.schedule_text_id,'approver_user_id',OLD.approver_user_id,'state',OLD.state,'token_expires_at',OLD.token_expires_at,'responded_at',OLD.responded_at,'comment',OLD.comment),json_object('schedule_text_id',NEW.schedule_text_id,'approver_user_id',NEW.approver_user_id,'state',NEW.state,'token_expires_at',NEW.token_expires_at,'responded_at',NEW.responded_at,'comment',NEW.comment),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_schedule_text_approvals_delete AFTER DELETE ON schedule_text_approvals
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'schedule_text_approvals',COALESCE(CAST(OLD.schedule_text_id AS TEXT),'') || ':' || COALESCE(CAST(OLD.approver_user_id AS TEXT),''),'delete',json_object('schedule_text_id',OLD.schedule_text_id,'approver_user_id',OLD.approver_user_id,'state',OLD.state,'token_expires_at',OLD.token_expires_at,'responded_at',OLD.responded_at,'comment',OLD.comment),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_scheduled_posts_insert AFTER INSERT ON scheduled_posts
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'scheduled_posts',COALESCE(CAST(NEW.id AS TEXT),''),'insert',NULL,json_object('id',NEW.id,'customer_id',NEW.customer_id,'created_by_user_id',NEW.created_by_user_id,'source_schedule_id',NEW.source_schedule_id,'source_schedule_id_raw',NEW.source_schedule_id_raw,'materialization_key',NEW.materialization_key,'platform',NEW.platform,'content',NEW.content,'scheduled_at',NEW.scheduled_at,'contains_url',NEW.contains_url,'image_url',NEW.image_url,'video_url',NEW.video_url,'facebook_page_id',NEW.facebook_page_id,'notify_email',NEW.notify_email,'lifecycle_state',NEW.lifecycle_state,'batch_id',NEW.batch_id,'approval_state',NEW.approval_state,'updated_at',NEW.updated_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_scheduled_posts_update AFTER UPDATE ON scheduled_posts
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'scheduled_posts',COALESCE(CAST(NEW.id AS TEXT),''),'update',json_object('id',OLD.id,'customer_id',OLD.customer_id,'created_by_user_id',OLD.created_by_user_id,'source_schedule_id',OLD.source_schedule_id,'source_schedule_id_raw',OLD.source_schedule_id_raw,'materialization_key',OLD.materialization_key,'platform',OLD.platform,'content',OLD.content,'scheduled_at',OLD.scheduled_at,'contains_url',OLD.contains_url,'image_url',OLD.image_url,'video_url',OLD.video_url,'facebook_page_id',OLD.facebook_page_id,'notify_email',OLD.notify_email,'lifecycle_state',OLD.lifecycle_state,'batch_id',OLD.batch_id,'approval_state',OLD.approval_state,'updated_at',OLD.updated_at),json_object('id',NEW.id,'customer_id',NEW.customer_id,'created_by_user_id',NEW.created_by_user_id,'source_schedule_id',NEW.source_schedule_id,'source_schedule_id_raw',NEW.source_schedule_id_raw,'materialization_key',NEW.materialization_key,'platform',NEW.platform,'content',NEW.content,'scheduled_at',NEW.scheduled_at,'contains_url',NEW.contains_url,'image_url',NEW.image_url,'video_url',NEW.video_url,'facebook_page_id',NEW.facebook_page_id,'notify_email',NEW.notify_email,'lifecycle_state',NEW.lifecycle_state,'batch_id',NEW.batch_id,'approval_state',NEW.approval_state,'updated_at',NEW.updated_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_scheduled_posts_delete AFTER DELETE ON scheduled_posts
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'scheduled_posts',COALESCE(CAST(OLD.id AS TEXT),''),'delete',json_object('id',OLD.id,'customer_id',OLD.customer_id,'created_by_user_id',OLD.created_by_user_id,'source_schedule_id',OLD.source_schedule_id,'source_schedule_id_raw',OLD.source_schedule_id_raw,'materialization_key',OLD.materialization_key,'platform',OLD.platform,'content',OLD.content,'scheduled_at',OLD.scheduled_at,'contains_url',OLD.contains_url,'image_url',OLD.image_url,'video_url',OLD.video_url,'facebook_page_id',OLD.facebook_page_id,'notify_email',OLD.notify_email,'lifecycle_state',OLD.lifecycle_state,'batch_id',OLD.batch_id,'approval_state',OLD.approval_state,'updated_at',OLD.updated_at),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_scheduled_post_approvals_insert AFTER INSERT ON scheduled_post_approvals
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'scheduled_post_approvals',COALESCE(CAST(NEW.scheduled_post_id AS TEXT),'') || ':' || COALESCE(CAST(NEW.approver_user_id AS TEXT),''),'insert',NULL,json_object('scheduled_post_id',NEW.scheduled_post_id,'approver_user_id',NEW.approver_user_id,'state',NEW.state,'token_expires_at',NEW.token_expires_at,'responded_at',NEW.responded_at,'comment',NEW.comment),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_scheduled_post_approvals_update AFTER UPDATE ON scheduled_post_approvals
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'scheduled_post_approvals',COALESCE(CAST(NEW.scheduled_post_id AS TEXT),'') || ':' || COALESCE(CAST(NEW.approver_user_id AS TEXT),''),'update',json_object('scheduled_post_id',OLD.scheduled_post_id,'approver_user_id',OLD.approver_user_id,'state',OLD.state,'token_expires_at',OLD.token_expires_at,'responded_at',OLD.responded_at,'comment',OLD.comment),json_object('scheduled_post_id',NEW.scheduled_post_id,'approver_user_id',NEW.approver_user_id,'state',NEW.state,'token_expires_at',NEW.token_expires_at,'responded_at',NEW.responded_at,'comment',NEW.comment),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_scheduled_post_approvals_delete AFTER DELETE ON scheduled_post_approvals
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'scheduled_post_approvals',COALESCE(CAST(OLD.scheduled_post_id AS TEXT),'') || ':' || COALESCE(CAST(OLD.approver_user_id AS TEXT),''),'delete',json_object('scheduled_post_id',OLD.scheduled_post_id,'approver_user_id',OLD.approver_user_id,'state',OLD.state,'token_expires_at',OLD.token_expires_at,'responded_at',OLD.responded_at,'comment',OLD.comment),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_posting_logs_insert AFTER INSERT ON posting_logs
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'posting_logs',COALESCE(CAST(NEW.id AS TEXT),''),'insert',NULL,json_object('id',NEW.id,'customer_id',NEW.customer_id,'created_by_user_id',NEW.created_by_user_id,'scheduled_post_id',NEW.scheduled_post_id,'platform',NEW.platform,'content',NEW.content,'external_post_id',NEW.external_post_id,'account_name',NEW.account_name,'posted_at',NEW.posted_at,'billing_period',NEW.billing_period,'contains_url',NEW.contains_url,'created_at',NEW.created_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_posting_logs_update AFTER UPDATE ON posting_logs
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'posting_logs',COALESCE(CAST(NEW.id AS TEXT),''),'update',json_object('id',OLD.id,'customer_id',OLD.customer_id,'created_by_user_id',OLD.created_by_user_id,'scheduled_post_id',OLD.scheduled_post_id,'platform',OLD.platform,'content',OLD.content,'external_post_id',OLD.external_post_id,'account_name',OLD.account_name,'posted_at',OLD.posted_at,'billing_period',OLD.billing_period,'contains_url',OLD.contains_url,'created_at',OLD.created_at),json_object('id',NEW.id,'customer_id',NEW.customer_id,'created_by_user_id',NEW.created_by_user_id,'scheduled_post_id',NEW.scheduled_post_id,'platform',NEW.platform,'content',NEW.content,'external_post_id',NEW.external_post_id,'account_name',NEW.account_name,'posted_at',NEW.posted_at,'billing_period',NEW.billing_period,'contains_url',NEW.contains_url,'created_at',NEW.created_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_posting_logs_delete AFTER DELETE ON posting_logs
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'posting_logs',COALESCE(CAST(OLD.id AS TEXT),''),'delete',json_object('id',OLD.id,'customer_id',OLD.customer_id,'created_by_user_id',OLD.created_by_user_id,'scheduled_post_id',OLD.scheduled_post_id,'platform',OLD.platform,'content',OLD.content,'external_post_id',OLD.external_post_id,'account_name',OLD.account_name,'posted_at',OLD.posted_at,'billing_period',OLD.billing_period,'contains_url',OLD.contains_url,'created_at',OLD.created_at),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_notifications_insert AFTER INSERT ON notifications
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'notifications',COALESCE(CAST(NEW.id AS TEXT),''),'insert',NULL,json_object('id',NEW.id,'customer_id',NEW.customer_id,'type',NEW.type,'title',NEW.title,'body',NEW.body,'platform',NEW.platform,'related_entity_type',NEW.related_entity_type,'related_entity_id',NEW.related_entity_id,'dedupe_key',NEW.dedupe_key,'created_at',NEW.created_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_notifications_update AFTER UPDATE ON notifications
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'notifications',COALESCE(CAST(NEW.id AS TEXT),''),'update',json_object('id',OLD.id,'customer_id',OLD.customer_id,'type',OLD.type,'title',OLD.title,'body',OLD.body,'platform',OLD.platform,'related_entity_type',OLD.related_entity_type,'related_entity_id',OLD.related_entity_id,'dedupe_key',OLD.dedupe_key,'created_at',OLD.created_at),json_object('id',NEW.id,'customer_id',NEW.customer_id,'type',NEW.type,'title',NEW.title,'body',NEW.body,'platform',NEW.platform,'related_entity_type',NEW.related_entity_type,'related_entity_id',NEW.related_entity_id,'dedupe_key',NEW.dedupe_key,'created_at',NEW.created_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_notifications_delete AFTER DELETE ON notifications
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'notifications',COALESCE(CAST(OLD.id AS TEXT),''),'delete',json_object('id',OLD.id,'customer_id',OLD.customer_id,'type',OLD.type,'title',OLD.title,'body',OLD.body,'platform',OLD.platform,'related_entity_type',OLD.related_entity_type,'related_entity_id',OLD.related_entity_id,'dedupe_key',OLD.dedupe_key,'created_at',OLD.created_at),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_notification_reads_insert AFTER INSERT ON notification_reads
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'notification_reads',COALESCE(CAST(NEW.user_id AS TEXT),''),'insert',NULL,json_object('user_id',NEW.user_id,'last_read_at',NEW.last_read_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_notification_reads_update AFTER UPDATE ON notification_reads
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'notification_reads',COALESCE(CAST(NEW.user_id AS TEXT),''),'update',json_object('user_id',OLD.user_id,'last_read_at',OLD.last_read_at),json_object('user_id',NEW.user_id,'last_read_at',NEW.last_read_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_notification_reads_delete AFTER DELETE ON notification_reads
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'notification_reads',COALESCE(CAST(OLD.user_id AS TEXT),''),'delete',json_object('user_id',OLD.user_id,'last_read_at',OLD.last_read_at),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_x_surcharge_versions_insert AFTER INSERT ON x_surcharge_versions
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'x_surcharge_versions',COALESCE(CAST(NEW.id AS TEXT),''),'insert',NULL,json_object('id',NEW.id,'amount',NEW.amount,'reference_usd',NEW.reference_usd,'reference_usd_updated_at',NEW.reference_usd_updated_at,'effective_at',NEW.effective_at,'state',NEW.state,'stripe_prices_json',NEW.stripe_prices_json,'created_by_user_id',NEW.created_by_user_id,'created_at',NEW.created_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_x_surcharge_versions_update AFTER UPDATE ON x_surcharge_versions
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'x_surcharge_versions',COALESCE(CAST(NEW.id AS TEXT),''),'update',json_object('id',OLD.id,'amount',OLD.amount,'reference_usd',OLD.reference_usd,'reference_usd_updated_at',OLD.reference_usd_updated_at,'effective_at',OLD.effective_at,'state',OLD.state,'stripe_prices_json',OLD.stripe_prices_json,'created_by_user_id',OLD.created_by_user_id,'created_at',OLD.created_at),json_object('id',NEW.id,'amount',NEW.amount,'reference_usd',NEW.reference_usd,'reference_usd_updated_at',NEW.reference_usd_updated_at,'effective_at',NEW.effective_at,'state',NEW.state,'stripe_prices_json',NEW.stripe_prices_json,'created_by_user_id',NEW.created_by_user_id,'created_at',NEW.created_at),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER journal_x_surcharge_versions_delete AFTER DELETE ON x_surcharge_versions
BEGIN
  INSERT INTO change_journal(transaction_id,entity_type,entity_id,operation,before_json,after_json,occurred_at)
  VALUES (lower(hex(randomblob(16))),'x_surcharge_versions',COALESCE(CAST(OLD.id AS TEXT),''),'delete',json_object('id',OLD.id,'amount',OLD.amount,'reference_usd',OLD.reference_usd,'reference_usd_updated_at',OLD.reference_usd_updated_at,'effective_at',OLD.effective_at,'state',OLD.state,'stripe_prices_json',OLD.stripe_prices_json,'created_by_user_id',OLD.created_by_user_id,'created_at',OLD.created_at),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
