'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  {
    version: 1,
    name: 'viewer_registry',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE models (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','importing','ready','failed','unregistered')),
        active_version_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        unregistered_at TEXT,
        UNIQUE(provider, provider_model_id)
      );

      CREATE TABLE model_versions (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        provider_version_id TEXT NOT NULL,
        source_locator_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','importing','ready','failed')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        georef_json TEXT NOT NULL DEFAULT '{}',
        point_count INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(model_id, provider_version_id)
      );

      CREATE INDEX model_versions_model_idx ON model_versions(model_id, created_at DESC);

      CREATE TABLE model_assets (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root_key TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        format TEXT,
        content_type TEXT,
        byte_size INTEGER,
        created_at TEXT NOT NULL,
        UNIQUE(version_id, kind)
      );

      CREATE TABLE model_aliases (
        alias_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE import_jobs (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        identifier TEXT NOT NULL,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','importing','ready','failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        result_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
        result_model_version_id TEXT REFERENCES model_versions(id) ON DELETE SET NULL,
        model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX import_jobs_status_idx ON import_jobs(status, created_at);

      CREATE TABLE public_shares (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        version_policy TEXT NOT NULL CHECK (version_policy IN ('latest','pinned')),
        model_version_id TEXT REFERENCES model_versions(id) ON DELETE RESTRICT,
        public_id_hash TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        permissions_json TEXT NOT NULL,
        label TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        revoked_by TEXT,
        revoke_reason TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT
      );

      CREATE INDEX public_shares_model_idx ON public_shares(model_id, created_at DESC);

      CREATE TABLE session_grants (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        subject TEXT NOT NULL,
        audience TEXT NOT NULL CHECK (audience IN ('ops','client')),
        permissions_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        redeemed_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX session_grants_expiry_idx ON session_grants(expires_at);

      CREATE TABLE service_nonces (
        key_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(key_id, nonce)
      );

      CREATE INDEX service_nonces_created_idx ON service_nonces(created_at);

      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX audit_events_created_idx ON audit_events(created_at DESC);
      CREATE INDEX audit_events_entity_idx ON audit_events(entity_type, entity_id, created_at DESC);
    `,
  },
  {
    version: 2,
    name: 'application_state',
    sql: `
      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'viewer_sessions',
    sql: `
      CREATE TABLE viewer_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        model_version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
        subject TEXT NOT NULL,
        audience TEXT NOT NULL CHECK (audience IN ('ops','client')),
        permissions_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX viewer_sessions_expiry_idx ON viewer_sessions(expires_at);
      CREATE INDEX viewer_sessions_model_idx ON viewer_sessions(model_id, expires_at);
    `,
  },
  {
    version: 4,
    name: 'service_idempotency',
    sql: `
      CREATE TABLE service_idempotency (
        key_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_status INTEGER,
        response_ciphertext TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(key_id, idempotency_key)
      );
      CREATE INDEX service_idempotency_expiry_idx ON service_idempotency(expires_at);
    `,
  },
  {
    version: 5,
    name: 'processing_platform',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        description TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        default_units TEXT NOT NULL DEFAULT 'imperial' CHECK(default_units IN ('imperial','metric')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE INDEX projects_page_idx ON projects(created_at DESC,id DESC);

      CREATE TABLE datasets (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        display_name TEXT NOT NULL,
        description TEXT,
        source_type TEXT NOT NULL DEFAULT 'upload',
        storage_mode TEXT NOT NULL CHECK(storage_mode IN ('managed','adopted','external_reference')),
        root_key TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft','finalizing','finalized','archived','trashed')),
        manifest_sha256 TEXT,
        file_count INTEGER NOT NULL DEFAULT 0,
        byte_size INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finalized_at TEXT,
        archived_at TEXT,
        trashed_at TEXT,
        UNIQUE(root_key, relative_path)
      );
      CREATE INDEX datasets_project_idx ON datasets(project_id, status, created_at DESC);
      CREATE INDEX datasets_page_idx ON datasets(created_at DESC,id DESC);
      CREATE INDEX datasets_project_page_idx ON datasets(project_id,created_at DESC,id DESC);

      CREATE TABLE dataset_files (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
        relative_path TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
        sha256 TEXT NOT NULL CHECK(length(sha256)=64),
        content_type TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(dataset_id, relative_path)
      );
      CREATE INDEX dataset_files_dataset_idx ON dataset_files(dataset_id, relative_path);

      CREATE TABLE upload_sessions (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        subject TEXT NOT NULL,
        expected_manifest_json TEXT NOT NULL,
        chunk_size INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open','finalizing','complete','expired','cancelled')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX upload_sessions_expiry_idx ON upload_sessions(status, expires_at);

      CREATE TABLE upload_chunks (
        upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        byte_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(upload_id, file_id, chunk_index)
      );

      CREATE TABLE processing_providers (
        id TEXT PRIMARY KEY,
        provider_type TEXT NOT NULL CHECK(provider_type IN ('nodeodm','clusterodm')),
        display_name TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        auth_env_key TEXT,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        admission_limit INTEGER NOT NULL DEFAULT 1 CHECK(admission_limit > 0),
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        capability_fingerprint TEXT,
        last_health TEXT,
        last_health_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX processing_providers_page_idx ON processing_providers(created_at DESC,id DESC);

      CREATE TABLE processing_presets (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        options_json TEXT NOT NULL,
        provider_type TEXT,
        capability_fingerprint TEXT,
        built_in INTEGER NOT NULL DEFAULT 0 CHECK(built_in IN (0,1)),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE processing_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
        display_name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL CHECK(status IN ('draft','queued','processing','ready_for_review','published','failed','cancelled','archived')),
        active_attempt_id TEXT,
        published_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE INDEX processing_tasks_project_idx ON processing_tasks(project_id, status, created_at DESC);
      CREATE INDEX processing_tasks_page_idx ON processing_tasks(created_at DESC,id DESC);
      CREATE INDEX processing_tasks_project_page_idx ON processing_tasks(project_id,created_at DESC,id DESC);

      CREATE TABLE processing_attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE RESTRICT,
        attempt_number INTEGER NOT NULL,
        provider_id TEXT REFERENCES processing_providers(id) ON DELETE SET NULL,
        provider_task_id TEXT,
        preset_id TEXT REFERENCES processing_presets(id) ON DELETE SET NULL,
        options_json TEXT NOT NULL,
        capability_fingerprint TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','admitted','initializing','uploading','committed','queued_upstream','running','ingesting','derivatives','ready_for_review','published','failed','cancelled')),
        progress REAL NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 1),
        provider_output_cursor INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        upstream_completed_at TEXT,
        ingested_at TEXT,
        completed_at TEXT,
        UNIQUE(task_id, attempt_number),
        UNIQUE(provider_id, provider_task_id)
      );
      CREATE INDEX processing_attempts_queue_idx ON processing_attempts(status, created_at);

      CREATE TABLE processing_jobs (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES processing_attempts(id) ON DELETE CASCADE,
        job_type TEXT NOT NULL CHECK(job_type IN ('submit','reconcile','ingest')),
        status TEXT NOT NULL CHECK(status IN ('pending','leased','complete','failed','cancelled')),
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX processing_jobs_claim_idx ON processing_jobs(status, available_at, lease_expires_at);

      CREATE TABLE processing_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id TEXT NOT NULL REFERENCES processing_attempts(id) ON DELETE CASCADE,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX processing_logs_attempt_idx ON processing_logs(attempt_id, created_at);

      CREATE TABLE derivative_jobs (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES processing_attempts(id) ON DELETE CASCADE,
        derivative_type TEXT NOT NULL CHECK(derivative_type IN ('ept','mesh_tiles','lod_audit')),
        status TEXT NOT NULL CHECK(status IN ('pending','leased','complete','failed','cancelled')),
        request_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT NOT NULL DEFAULT '{}',
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE admin_grants (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        subject TEXT NOT NULL,
        permissions_json TEXT NOT NULL,
        display_units TEXT NOT NULL DEFAULT 'imperial' CHECK(display_units IN ('imperial','metric')),
        expires_at TEXT NOT NULL,
        authorization_expires_at TEXT NOT NULL,
        redeemed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX admin_grants_expiry_idx ON admin_grants(expires_at);

      CREATE TABLE admin_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        subject TEXT NOT NULL,
        permissions_json TEXT NOT NULL,
        display_units TEXT NOT NULL DEFAULT 'imperial' CHECK(display_units IN ('imperial','metric')),
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX admin_sessions_expiry_idx ON admin_sessions(expires_at);

      CREATE TABLE abuse_windows (
        bucket_key TEXT PRIMARY KEY,
        window_started_at TEXT NOT NULL,
        hit_count INTEGER NOT NULL,
        blocked_until TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE admin_idempotency (
        session_id TEXT NOT NULL REFERENCES admin_sessions(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_status INTEGER,
        response_json TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(session_id, idempotency_key)
      );
      CREATE INDEX admin_idempotency_expiry_idx ON admin_idempotency(expires_at);

      CREATE TABLE dataset_import_previews (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        request_json TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        claimed_at TEXT,
        claim_id TEXT,
        consumed_at TEXT,
        created_by TEXT,
        created_session_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE event_outbox (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','leased','delivered','failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        lease_expires_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT
      );
      CREATE INDEX event_outbox_claim_idx ON event_outbox(status, available_at, lease_expires_at);

      CREATE TABLE storage_trash (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        root_key TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        byte_size INTEGER NOT NULL DEFAULT 0,
        purge_after TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        permanently_deleted_at TEXT
      );
      CREATE INDEX storage_trash_page_idx ON storage_trash(permanently_deleted_at,created_at DESC,id DESC);
      CREATE INDEX storage_trash_purge_idx ON storage_trash(purge_after, permanently_deleted_at);

      ALTER TABLE public_shares ADD COLUMN display_units TEXT CHECK(display_units IN ('imperial','metric'));
      ALTER TABLE session_grants ADD COLUMN display_units TEXT NOT NULL DEFAULT 'imperial' CHECK(display_units IN ('imperial','metric'));
      ALTER TABLE viewer_sessions ADD COLUMN display_units TEXT NOT NULL DEFAULT 'imperial' CHECK(display_units IN ('imperial','metric'));
      ALTER TABLE model_assets ADD COLUMN storage_mode TEXT NOT NULL DEFAULT 'external_reference'
        CHECK(storage_mode IN ('managed','adopted','external_reference'));
      ALTER TABLE model_assets ADD COLUMN published INTEGER NOT NULL DEFAULT 1 CHECK(published IN (0,1));
      ALTER TABLE model_assets ADD COLUMN source_attempt_id TEXT REFERENCES processing_attempts(id) ON DELETE SET NULL;
    `,
  },
  {
    version: 6,
    name: 'durable_dataset_operations',
    sql: `
      CREATE TABLE dataset_operations (
        id TEXT PRIMARY KEY,
        operation_type TEXT NOT NULL CHECK(operation_type IN ('upload_finalize','import_adopt')),
        subject TEXT NOT NULL,
        session_id TEXT,
        dataset_id TEXT REFERENCES datasets(id) ON DELETE SET NULL,
        upload_id TEXT REFERENCES upload_sessions(id) ON DELETE SET NULL,
        import_preview_id TEXT REFERENCES dataset_import_previews(id) ON DELETE SET NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK(status IN ('queued','leased','succeeded','failed','cancelled')),
        progress REAL NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 1),
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX dataset_operations_claim_idx
        ON dataset_operations(status,available_at,lease_expires_at,created_at);
      CREATE INDEX dataset_operations_subject_idx
        ON dataset_operations(subject,created_at DESC,id DESC);
      CREATE UNIQUE INDEX dataset_operations_active_upload_idx
        ON dataset_operations(upload_id)
        WHERE upload_id IS NOT NULL AND status IN ('queued','leased','succeeded');
      CREATE UNIQUE INDEX dataset_operations_active_preview_idx
        ON dataset_operations(import_preview_id)
        WHERE import_preview_id IS NOT NULL AND status IN ('queued','leased','succeeded');
    `,
  },
  {
    version: 7,
    name: 'immutable_model_asset_manifests',
    sql: `
      ALTER TABLE model_assets ADD COLUMN sha256 TEXT;
      ALTER TABLE model_assets ADD COLUMN manifest_sha256 TEXT;
      CREATE TABLE model_asset_files (
        asset_id TEXT NOT NULL REFERENCES model_assets(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
        sha256 TEXT NOT NULL CHECK(length(sha256)=64),
        PRIMARY KEY(asset_id,relative_path)
      );
      CREATE INDEX model_asset_files_asset_idx ON model_asset_files(asset_id,relative_path);
    `,
  },
  {
    version: 8,
    name: 'idempotent_derivative_jobs',
    sql: `
      DELETE FROM derivative_jobs
      WHERE rowid NOT IN (SELECT MIN(rowid) FROM derivative_jobs GROUP BY attempt_id,derivative_type);
      CREATE UNIQUE INDEX derivative_jobs_attempt_type_idx ON derivative_jobs(attempt_id,derivative_type);
    `,
  },
  {
    version: 9,
    name: 'storage_lifecycle_journal',
    sql: `
      CREATE TABLE storage_mutations (
        id TEXT PRIMARY KEY,
        mutation_type TEXT NOT NULL CHECK(mutation_type IN ('trash','restore','purge')),
        entity_type TEXT NOT NULL CHECK(entity_type='dataset'),
        entity_id TEXT NOT NULL,
        trash_id TEXT NOT NULL,
        source_root_key TEXT,
        source_relative_path TEXT,
        destination_root_key TEXT,
        destination_relative_path TEXT,
        allow_absent_source INTEGER NOT NULL DEFAULT 0 CHECK(allow_absent_source IN (0,1)),
        status TEXT NOT NULL CHECK(status IN ('intent','fs_applied','complete','failed')),
        actor TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE UNIQUE INDEX storage_mutations_active_entity_idx
        ON storage_mutations(entity_type,entity_id)
        WHERE status IN ('intent','fs_applied');
      CREATE INDEX storage_mutations_reconcile_idx ON storage_mutations(status,created_at);
      CREATE INDEX storage_mutations_trash_idx ON storage_mutations(trash_id,status);
      UPDATE storage_trash SET permanently_deleted_at=created_at
        WHERE permanently_deleted_at IS NULL AND rowid NOT IN (
          SELECT MAX(rowid) FROM storage_trash WHERE permanently_deleted_at IS NULL GROUP BY entity_type,entity_id
        );
      CREATE UNIQUE INDEX storage_trash_active_entity_idx
        ON storage_trash(entity_type,entity_id) WHERE permanently_deleted_at IS NULL;
    `,
  },
  {
    version: 10,
    name: 'processing_resume_tags_and_output_lifecycle',
    sql: `
      ALTER TABLE projects ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE datasets ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE processing_attempts ADD COLUMN submission_phase TEXT NOT NULL DEFAULT 'new'
        CHECK(submission_phase IN ('new','initializing','initialized','uploading','uploading_auxiliary','uploaded','committing','committed'));
      ALTER TABLE processing_attempts ADD COLUMN uploaded_file_count INTEGER NOT NULL DEFAULT 0
        CHECK(uploaded_file_count >= 0);
      ALTER TABLE processing_attempts ADD COLUMN result_model_id TEXT REFERENCES models(id) ON DELETE SET NULL;
      ALTER TABLE processing_attempts ADD COLUMN result_model_version_id TEXT REFERENCES model_versions(id) ON DELETE SET NULL;

      CREATE TABLE model_outputs (
        id TEXT PRIMARY KEY REFERENCES model_versions(id) ON DELETE RESTRICT,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL UNIQUE REFERENCES processing_attempts(id) ON DELETE RESTRICT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        root_key TEXT NOT NULL DEFAULT 'models' CHECK(root_key='models'),
        relative_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ready','published','archived','trashed')),
        byte_size INTEGER NOT NULL DEFAULT 0 CHECK(byte_size >= 0),
        asset_count INTEGER NOT NULL DEFAULT 0 CHECK(asset_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        trashed_at TEXT,
        UNIQUE(root_key,relative_path)
      );
      CREATE INDEX model_outputs_page_idx ON model_outputs(created_at DESC,id DESC);
      CREATE INDEX model_outputs_project_page_idx ON model_outputs(project_id,created_at DESC,id DESC);
      CREATE INDEX model_outputs_task_page_idx ON model_outputs(task_id,created_at DESC,id DESC);
      CREATE INDEX model_outputs_status_page_idx ON model_outputs(status,created_at DESC,id DESC);
      INSERT INTO model_outputs(id,model_id,task_id,attempt_id,project_id,root_key,relative_path,status,byte_size,asset_count,created_at,updated_at)
      SELECT v.id,v.model_id,a.task_id,a.id,t.project_id,'models',t.id||'/'||a.id,
        CASE WHEN a.status='published' THEN 'published' ELSE 'ready' END,
        COALESCE((SELECT SUM(COALESCE(ma.byte_size,0)) FROM model_assets ma WHERE ma.version_id=v.id),0),
        (SELECT COUNT(*) FROM model_assets ma WHERE ma.version_id=v.id),v.created_at,v.updated_at
      FROM model_versions v
      JOIN processing_attempts a ON a.result_model_version_id=v.id
      JOIN processing_tasks t ON t.id=a.task_id;

      DROP INDEX storage_mutations_active_entity_idx;
      DROP INDEX storage_mutations_reconcile_idx;
      DROP INDEX storage_mutations_trash_idx;
      ALTER TABLE storage_mutations RENAME TO storage_mutations_v9;
      CREATE TABLE storage_mutations (
        id TEXT PRIMARY KEY,
        mutation_type TEXT NOT NULL CHECK(mutation_type IN ('trash','restore','purge')),
        entity_type TEXT NOT NULL CHECK(entity_type IN ('dataset','output')),
        entity_id TEXT NOT NULL,
        trash_id TEXT NOT NULL,
        source_root_key TEXT,
        source_relative_path TEXT,
        destination_root_key TEXT,
        destination_relative_path TEXT,
        allow_absent_source INTEGER NOT NULL DEFAULT 0 CHECK(allow_absent_source IN (0,1)),
        status TEXT NOT NULL CHECK(status IN ('intent','fs_applied','complete','failed')),
        actor TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      INSERT INTO storage_mutations SELECT * FROM storage_mutations_v9;
      DROP TABLE storage_mutations_v9;
      CREATE UNIQUE INDEX storage_mutations_active_entity_idx
        ON storage_mutations(entity_type,entity_id) WHERE status IN ('intent','fs_applied');
      CREATE INDEX storage_mutations_reconcile_idx ON storage_mutations(status,created_at);
      CREATE INDEX storage_mutations_trash_idx ON storage_mutations(trash_id,status);
    `,
  },
  {
    version: 11,
    name: 'gcp_workflow_and_dataset_image_index',
    sql: `
      ALTER TABLE dataset_files ADD COLUMN mime_type TEXT;
      ALTER TABLE dataset_files ADD COLUMN captured_at TEXT;
      ALTER TABLE dataset_files ADD COLUMN latitude REAL CHECK(latitude IS NULL OR (latitude >= -90 AND latitude <= 90));
      ALTER TABLE dataset_files ADD COLUMN longitude REAL CHECK(longitude IS NULL OR (longitude >= -180 AND longitude <= 180));
      ALTER TABLE dataset_files ADD COLUMN altitude_m REAL;
      ALTER TABLE dataset_files ADD COLUMN width INTEGER CHECK(width IS NULL OR width > 0);
      ALTER TABLE dataset_files ADD COLUMN height INTEGER CHECK(height IS NULL OR height > 0);
      UPDATE dataset_files SET
        mime_type=content_type,
        captured_at=CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.capturedAt') END,
        latitude=CASE WHEN json_valid(metadata_json) AND json_type(metadata_json,'$.gps.latitude') IN ('integer','real')
          AND json_extract(metadata_json,'$.gps.latitude') BETWEEN -90 AND 90 THEN json_extract(metadata_json,'$.gps.latitude') END,
        longitude=CASE WHEN json_valid(metadata_json) AND json_type(metadata_json,'$.gps.longitude') IN ('integer','real')
          AND json_extract(metadata_json,'$.gps.longitude') BETWEEN -180 AND 180 THEN json_extract(metadata_json,'$.gps.longitude') END,
        altitude_m=CASE WHEN json_valid(metadata_json) AND json_type(metadata_json,'$.gps.altitudeM') IN ('integer','real') THEN json_extract(metadata_json,'$.gps.altitudeM') END,
        width=CASE WHEN json_valid(metadata_json) AND json_type(metadata_json,'$.width')='integer'
          AND json_extract(metadata_json,'$.width') > 0 THEN json_extract(metadata_json,'$.width') END,
        height=CASE WHEN json_valid(metadata_json) AND json_type(metadata_json,'$.height')='integer'
          AND json_extract(metadata_json,'$.height') > 0 THEN json_extract(metadata_json,'$.height') END;
      CREATE INDEX dataset_files_gps_idx ON dataset_files(dataset_id,latitude,longitude)
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

      CREATE TABLE gcp_sets (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
        display_name TEXT NOT NULL,
        source_format TEXT NOT NULL CHECK(source_format IN ('generic-csv-v1','generic-geojson-v1')),
        source_file_id TEXT REFERENCES dataset_files(id) ON DELETE RESTRICT,
        source_filename TEXT,
        source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
        source_content TEXT NOT NULL,
        source_byte_size INTEGER NOT NULL CHECK(source_byte_size >= 0 AND source_byte_size <= 2097152),
        crs TEXT NOT NULL CHECK(crs='EPSG:4326'),
        elevation_units TEXT NOT NULL CHECK(elevation_units='m'),
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX gcp_sets_dataset_idx ON gcp_sets(dataset_id,created_at DESC,id DESC);
      CREATE TRIGGER gcp_set_source_dataset_insert BEFORE INSERT ON gcp_sets
      WHEN NEW.source_file_id IS NOT NULL AND COALESCE((SELECT dataset_id FROM dataset_files WHERE id=NEW.source_file_id),'') <> NEW.dataset_id
      BEGIN SELECT RAISE(ABORT,'gcp_source_dataset_mismatch'); END;
      CREATE TRIGGER gcp_set_source_dataset_update BEFORE UPDATE OF dataset_id,source_file_id ON gcp_sets
      WHEN NEW.source_file_id IS NOT NULL AND COALESCE((SELECT dataset_id FROM dataset_files WHERE id=NEW.source_file_id),'') <> NEW.dataset_id
      BEGIN SELECT RAISE(ABORT,'gcp_source_dataset_mismatch'); END;

      CREATE TABLE gcp_points (
        id TEXT PRIMARY KEY,
        set_id TEXT NOT NULL REFERENCES gcp_sets(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        label TEXT NOT NULL,
        latitude REAL NOT NULL CHECK(latitude >= -90 AND latitude <= 90),
        longitude REAL NOT NULL CHECK(longitude >= -180 AND longitude <= 180),
        elevation_m REAL NOT NULL CHECK(elevation_m >= -12000 AND elevation_m <= 100000),
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(set_id,external_id)
      );
      CREATE INDEX gcp_points_set_idx ON gcp_points(set_id,external_id,id);

      CREATE TABLE gcp_image_correspondences (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE RESTRICT,
        gcp_point_id TEXT NOT NULL REFERENCES gcp_points(id) ON DELETE CASCADE,
        dataset_file_id TEXT NOT NULL REFERENCES dataset_files(id) ON DELETE RESTRICT,
        pixel_x REAL NOT NULL CHECK(pixel_x >= 0),
        pixel_y REAL NOT NULL CHECK(pixel_y >= 0),
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id,gcp_point_id,dataset_file_id)
      );
      CREATE INDEX gcp_correspondences_task_idx ON gcp_image_correspondences(task_id,created_at,id);

      CREATE TRIGGER gcp_correspondence_dataset_insert
      BEFORE INSERT ON gcp_image_correspondences
      WHEN COALESCE((SELECT dataset_id FROM processing_tasks WHERE id=NEW.task_id),'') = ''
        OR COALESCE((SELECT sets.dataset_id FROM gcp_points points JOIN gcp_sets sets ON sets.id=points.set_id WHERE points.id=NEW.gcp_point_id),'') = ''
        OR COALESCE((SELECT dataset_id FROM dataset_files WHERE id=NEW.dataset_file_id),'') = ''
        OR (SELECT dataset_id FROM processing_tasks WHERE id=NEW.task_id) <>
          (SELECT sets.dataset_id FROM gcp_points points JOIN gcp_sets sets ON sets.id=points.set_id WHERE points.id=NEW.gcp_point_id)
        OR (SELECT dataset_id FROM processing_tasks WHERE id=NEW.task_id) <>
          (SELECT dataset_id FROM dataset_files WHERE id=NEW.dataset_file_id)
      BEGIN SELECT RAISE(ABORT,'gcp_dataset_mismatch'); END;

      CREATE TRIGGER gcp_correspondence_dataset_update
      BEFORE UPDATE OF task_id,gcp_point_id,dataset_file_id ON gcp_image_correspondences
      WHEN COALESCE((SELECT dataset_id FROM processing_tasks WHERE id=NEW.task_id),'') = ''
        OR COALESCE((SELECT sets.dataset_id FROM gcp_points points JOIN gcp_sets sets ON sets.id=points.set_id WHERE points.id=NEW.gcp_point_id),'') = ''
        OR COALESCE((SELECT dataset_id FROM dataset_files WHERE id=NEW.dataset_file_id),'') = ''
        OR (SELECT dataset_id FROM processing_tasks WHERE id=NEW.task_id) <>
          (SELECT sets.dataset_id FROM gcp_points points JOIN gcp_sets sets ON sets.id=points.set_id WHERE points.id=NEW.gcp_point_id)
        OR (SELECT dataset_id FROM processing_tasks WHERE id=NEW.task_id) <>
          (SELECT dataset_id FROM dataset_files WHERE id=NEW.dataset_file_id)
      BEGIN SELECT RAISE(ABORT,'gcp_dataset_mismatch'); END;

      CREATE TRIGGER gcp_correspondence_pixels_insert
      BEFORE INSERT ON gcp_image_correspondences
      WHEN ((SELECT width FROM dataset_files WHERE id=NEW.dataset_file_id) IS NOT NULL
          AND NEW.pixel_x >= (SELECT width FROM dataset_files WHERE id=NEW.dataset_file_id))
        OR ((SELECT height FROM dataset_files WHERE id=NEW.dataset_file_id) IS NOT NULL
          AND NEW.pixel_y >= (SELECT height FROM dataset_files WHERE id=NEW.dataset_file_id))
      BEGIN SELECT RAISE(ABORT,'gcp_pixel_out_of_bounds'); END;

      CREATE TRIGGER gcp_correspondence_pixels_update
      BEFORE UPDATE OF dataset_file_id,pixel_x,pixel_y ON gcp_image_correspondences
      WHEN ((SELECT width FROM dataset_files WHERE id=NEW.dataset_file_id) IS NOT NULL
          AND NEW.pixel_x >= (SELECT width FROM dataset_files WHERE id=NEW.dataset_file_id))
        OR ((SELECT height FROM dataset_files WHERE id=NEW.dataset_file_id) IS NOT NULL
          AND NEW.pixel_y >= (SELECT height FROM dataset_files WHERE id=NEW.dataset_file_id))
      BEGIN SELECT RAISE(ABORT,'gcp_pixel_out_of_bounds'); END;

      CREATE TABLE processing_attempt_gcp_snapshots (
        attempt_id TEXT PRIMARY KEY REFERENCES processing_attempts(id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL CHECK(length(sha256)=64),
        content_text TEXT NOT NULL,
        correspondence_count INTEGER NOT NULL CHECK(correspondence_count > 0),
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 12,
    name: 'encrypted_processing_provider_credentials',
    sql: `
      ALTER TABLE processing_providers ADD COLUMN credential_ciphertext TEXT;
      ALTER TABLE processing_providers ADD COLUMN credential_key_id TEXT;
      ALTER TABLE processing_providers ADD COLUMN credential_updated_at TEXT;
      ALTER TABLE processing_providers ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0
        CHECK(credential_revision >= 0);
      ALTER TABLE processing_providers ADD COLUMN credential_cleared INTEGER NOT NULL DEFAULT 0
        CHECK(credential_cleared IN (0,1));
      ALTER TABLE processing_providers ADD COLUMN last_probe_credential_revision INTEGER;
    `,
  },
  {
    version: 13,
    name: 'durable_import_preview_operations',
    sql: `
      DROP INDEX dataset_operations_claim_idx;
      DROP INDEX dataset_operations_subject_idx;
      DROP INDEX dataset_operations_active_upload_idx;
      DROP INDEX dataset_operations_active_preview_idx;
      ALTER TABLE dataset_operations RENAME TO dataset_operations_v12;
      CREATE TABLE dataset_operations (
        id TEXT PRIMARY KEY,
        operation_type TEXT NOT NULL CHECK(operation_type IN ('upload_finalize','import_preview','import_adopt')),
        subject TEXT NOT NULL,
        session_id TEXT,
        dataset_id TEXT REFERENCES datasets(id) ON DELETE SET NULL,
        upload_id TEXT REFERENCES upload_sessions(id) ON DELETE SET NULL,
        import_preview_id TEXT REFERENCES dataset_import_previews(id) ON DELETE SET NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK(status IN ('queued','leased','succeeded','failed','cancelled')),
        progress REAL NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 1),
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      INSERT INTO dataset_operations SELECT * FROM dataset_operations_v12;
      DROP TABLE dataset_operations_v12;
      CREATE INDEX dataset_operations_claim_idx
        ON dataset_operations(status,available_at,lease_expires_at,created_at);
      CREATE INDEX dataset_operations_subject_idx
        ON dataset_operations(subject,created_at DESC,id DESC);
      CREATE UNIQUE INDEX dataset_operations_active_upload_idx
        ON dataset_operations(upload_id)
        WHERE upload_id IS NOT NULL AND status IN ('queued','leased','succeeded');
      CREATE UNIQUE INDEX dataset_operations_active_preview_idx
        ON dataset_operations(import_preview_id)
        WHERE import_preview_id IS NOT NULL AND status IN ('queued','leased','succeeded');
    `,
  },
  {
    version: 14,
    name: 'catalog_imports_presets_and_authorization',
    sql: `
      ALTER TABLE processing_presets ADD COLUMN description TEXT;
      UPDATE processing_presets SET options_json='{"orthophoto-resolution":2}' WHERE id='orthophoto';

      -- A task points at its current dataset, while every attempt retains the
      -- exact immutable dataset snapshot it processed. This is required when
      -- an externally referenced catalog source is rescanned into a new model
      -- version without changing the stable LTDS task identity.
      ALTER TABLE processing_attempts ADD COLUMN dataset_id TEXT REFERENCES datasets(id) ON DELETE RESTRICT;
      UPDATE processing_attempts
        SET dataset_id=(SELECT dataset_id FROM processing_tasks WHERE processing_tasks.id=processing_attempts.task_id)
        WHERE dataset_id IS NULL;
      CREATE INDEX processing_attempts_dataset_idx ON processing_attempts(dataset_id,created_at DESC);

      ALTER TABLE processing_providers ADD COLUMN runtime_health TEXT CHECK(runtime_health IN ('healthy','unhealthy'));
      ALTER TABLE processing_providers ADD COLUMN runtime_health_at TEXT;
      ALTER TABLE processing_providers ADD COLUMN runtime_health_error TEXT;
      ALTER TABLE processing_providers ADD COLUMN runtime_health_owner TEXT;
      ALTER TABLE processing_providers ADD COLUMN runtime_health_lease_expires_at TEXT;

      CREATE TABLE catalog_import_scans (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK(provider IN ('webodm','terra')),
        generation INTEGER NOT NULL CHECK(generation > 0),
        candidate_count INTEGER NOT NULL DEFAULT 0 CHECK(candidate_count >= 0),
        created_by TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(provider,generation)
      );

      CREATE TABLE catalog_import_candidates (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK(provider IN ('webodm','terra')),
        external_project_id TEXT NOT NULL,
        external_task_id TEXT NOT NULL,
        source_root_key TEXT NOT NULL CHECK(source_root_key IN ('webodm','terra_import')),
        source_relative_path TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        suggested_project_name TEXT NOT NULL,
        suggested_task_name TEXT NOT NULL,
        assets_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'unmapped' CHECK(state IN ('unmapped','mapped','stale')),
        stale_reason TEXT CHECK(stale_reason IN ('source_changed','not_seen')),
        scan_generation INTEGER NOT NULL CHECK(scan_generation > 0),
        last_seen_at TEXT NOT NULL,
        mapped_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        mapped_task_id TEXT REFERENCES processing_tasks(id) ON DELETE SET NULL,
        mapped_dataset_id TEXT REFERENCES datasets(id) ON DELETE SET NULL,
        mapped_attempt_id TEXT REFERENCES processing_attempts(id) ON DELETE SET NULL,
        mapped_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
        mapped_model_version_id TEXT REFERENCES model_versions(id) ON DELETE SET NULL,
        mapped_source_fingerprint TEXT,
        mapped_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider,external_project_id,external_task_id,source_relative_path)
      );
      CREATE INDEX catalog_import_candidates_page_idx
        ON catalog_import_candidates(provider,state,updated_at DESC,id DESC);

      DROP INDEX model_outputs_page_idx;
      DROP INDEX model_outputs_project_page_idx;
      DROP INDEX model_outputs_task_page_idx;
      DROP INDEX model_outputs_status_page_idx;
      ALTER TABLE model_outputs RENAME TO model_outputs_v13;
      CREATE TABLE model_outputs (
        id TEXT PRIMARY KEY REFERENCES model_versions(id) ON DELETE RESTRICT,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL UNIQUE REFERENCES processing_attempts(id) ON DELETE RESTRICT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        root_key TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        storage_mode TEXT NOT NULL DEFAULT 'managed'
          CHECK(storage_mode IN ('managed','adopted','external_reference')),
        status TEXT NOT NULL CHECK(status IN ('ready','published','archived','trashed')),
        byte_size INTEGER NOT NULL DEFAULT 0 CHECK(byte_size >= 0),
        asset_count INTEGER NOT NULL DEFAULT 0 CHECK(asset_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        trashed_at TEXT,
        UNIQUE(root_key,relative_path)
      );
      INSERT INTO model_outputs(id,model_id,task_id,attempt_id,project_id,root_key,relative_path,storage_mode,status,byte_size,asset_count,created_at,updated_at,archived_at,trashed_at)
        SELECT id,model_id,task_id,attempt_id,project_id,root_key,relative_path,'managed',status,byte_size,asset_count,created_at,updated_at,archived_at,trashed_at
        FROM model_outputs_v13;
      DROP TABLE model_outputs_v13;
      CREATE INDEX model_outputs_page_idx ON model_outputs(created_at DESC,id DESC);
      CREATE INDEX model_outputs_project_page_idx ON model_outputs(project_id,created_at DESC,id DESC);
      CREATE INDEX model_outputs_task_page_idx ON model_outputs(task_id,created_at DESC,id DESC);
      CREATE INDEX model_outputs_status_page_idx ON model_outputs(status,created_at DESC,id DESC);

      DROP INDEX dataset_operations_claim_idx;
      DROP INDEX dataset_operations_subject_idx;
      DROP INDEX dataset_operations_active_upload_idx;
      DROP INDEX dataset_operations_active_preview_idx;
      ALTER TABLE dataset_operations RENAME TO dataset_operations_v13;
      CREATE TABLE dataset_operations (
        id TEXT PRIMARY KEY,
        operation_type TEXT NOT NULL CHECK(operation_type IN ('upload_finalize','import_preview','import_adopt','catalog_scan','catalog_map')),
        subject TEXT NOT NULL,
        session_id TEXT,
        dataset_id TEXT REFERENCES datasets(id) ON DELETE SET NULL,
        upload_id TEXT REFERENCES upload_sessions(id) ON DELETE SET NULL,
        import_preview_id TEXT REFERENCES dataset_import_previews(id) ON DELETE SET NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK(status IN ('queued','leased','succeeded','failed','cancelled')),
        progress REAL NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 1),
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      INSERT INTO dataset_operations SELECT * FROM dataset_operations_v13;
      DROP TABLE dataset_operations_v13;
      CREATE INDEX dataset_operations_claim_idx
        ON dataset_operations(status,available_at,lease_expires_at,created_at);
      CREATE INDEX dataset_operations_subject_idx
        ON dataset_operations(subject,created_at DESC,id DESC);
      CREATE UNIQUE INDEX dataset_operations_active_upload_idx
        ON dataset_operations(upload_id)
        WHERE upload_id IS NOT NULL AND status IN ('queued','leased','succeeded');
      CREATE UNIQUE INDEX dataset_operations_active_preview_idx
        ON dataset_operations(import_preview_id)
        WHERE import_preview_id IS NOT NULL AND status IN ('queued','leased','succeeded');

      ALTER TABLE public_shares ADD COLUMN source_authorization_id TEXT;
      ALTER TABLE public_shares ADD COLUMN source_authorization_version TEXT;
      ALTER TABLE public_shares ADD COLUMN source_authorization_subject TEXT;
      ALTER TABLE public_shares ADD COLUMN source_authorization_expires_at TEXT;
      ALTER TABLE public_shares ADD COLUMN source_authorization_revoked_at TEXT;
      ALTER TABLE public_shares ADD COLUMN share_class TEXT NOT NULL DEFAULT 'staff' CHECK(share_class IN ('staff','client'));
      CREATE INDEX public_shares_source_authorization_idx
        ON public_shares(source_authorization_id,source_authorization_version);

      CREATE TABLE model_asset_chunks (
        asset_id TEXT NOT NULL REFERENCES model_assets(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
        byte_offset INTEGER NOT NULL CHECK(byte_offset >= 0),
        byte_size INTEGER NOT NULL CHECK(byte_size > 0),
        sha256 TEXT NOT NULL CHECK(length(sha256)=64),
        PRIMARY KEY(asset_id,relative_path,chunk_index)
      );
      CREATE INDEX model_asset_chunks_lookup_idx ON model_asset_chunks(asset_id,relative_path,byte_offset);

      CREATE TABLE task_submissions (
        subject TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
        task_id TEXT NOT NULL UNIQUE REFERENCES processing_tasks(id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL UNIQUE REFERENCES processing_attempts(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(subject,submission_id)
      );

      CREATE TABLE subject_operation_receipts (
        subject TEXT NOT NULL,
        client_key TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
        response_status INTEGER,
        response_json TEXT,
        operation_id TEXT REFERENCES dataset_operations(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(subject,client_key)
      );
      CREATE INDEX subject_operation_receipts_operation_idx ON subject_operation_receipts(operation_id);
    `,
  },
  {
    version: 15,
    name: 'unpublished_review_sessions',
    sql: `
      ALTER TABLE session_grants ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'published'
        CHECK(session_mode IN ('published','review'));
      ALTER TABLE session_grants ADD COLUMN model_version_id TEXT REFERENCES model_versions(id) ON DELETE RESTRICT;
      ALTER TABLE session_grants ADD COLUMN review_attempt_id TEXT REFERENCES processing_attempts(id) ON DELETE CASCADE;
      CREATE INDEX session_grants_review_attempt_idx
        ON session_grants(review_attempt_id,subject,expires_at);

      ALTER TABLE viewer_sessions ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'published'
        CHECK(session_mode IN ('published','review'));
      ALTER TABLE viewer_sessions ADD COLUMN review_attempt_id TEXT REFERENCES processing_attempts(id) ON DELETE CASCADE;
      CREATE INDEX viewer_sessions_review_attempt_idx
        ON viewer_sessions(review_attempt_id,subject,expires_at);
    `,
  },
  {
    version: 16,
    name: 'processing_roles_and_staged_outputs',
    sql: `
      ALTER TABLE dataset_files ADD COLUMN processing_role TEXT NOT NULL DEFAULT 'auto'
        CHECK(processing_role IN ('auto','image','gcp_source','provider_input','administrative'));
      UPDATE dataset_files SET processing_role=CASE
        WHEN lower(relative_path) GLOB '*.csv' THEN 'gcp_source'
        WHEN lower(relative_path) GLOB '*.jpg' OR lower(relative_path) GLOB '*.jpeg'
          OR lower(relative_path) GLOB '*.png' OR lower(relative_path) GLOB '*.tif'
          OR lower(relative_path) GLOB '*.tiff' OR lower(relative_path) GLOB '*.dng'
          OR lower(relative_path) GLOB '*.raw' OR lower(relative_path) GLOB '*.heic'
          THEN 'image'
        ELSE 'auto'
      END;

      DROP INDEX model_outputs_page_idx;
      DROP INDEX model_outputs_project_page_idx;
      DROP INDEX model_outputs_task_page_idx;
      DROP INDEX model_outputs_status_page_idx;
      ALTER TABLE model_outputs RENAME TO model_outputs_v15;
      CREATE TABLE model_outputs (
        id TEXT PRIMARY KEY REFERENCES model_versions(id) ON DELETE RESTRICT,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL UNIQUE REFERENCES processing_attempts(id) ON DELETE RESTRICT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        root_key TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        storage_mode TEXT NOT NULL DEFAULT 'managed'
          CHECK(storage_mode IN ('managed','adopted','external_reference')),
        status TEXT NOT NULL CHECK(status IN ('staged','ready','published','failed','archived','trashed')),
        byte_size INTEGER NOT NULL DEFAULT 0 CHECK(byte_size >= 0),
        asset_count INTEGER NOT NULL DEFAULT 0 CHECK(asset_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        trashed_at TEXT,
        UNIQUE(root_key,relative_path)
      );
      INSERT INTO model_outputs(id,model_id,task_id,attempt_id,project_id,root_key,relative_path,storage_mode,status,byte_size,asset_count,created_at,updated_at,archived_at,trashed_at)
        SELECT id,model_id,task_id,attempt_id,project_id,root_key,relative_path,storage_mode,status,byte_size,asset_count,created_at,updated_at,archived_at,trashed_at
        FROM model_outputs_v15;
      UPDATE model_outputs SET status='failed'
        WHERE status='ready'
          AND attempt_id IN (SELECT id FROM processing_attempts WHERE status IN ('failed','cancelled'))
          AND NOT EXISTS (SELECT 1 FROM models WHERE models.id=model_outputs.model_id AND models.active_version_id=model_outputs.id);
      UPDATE model_versions SET status='failed'
        WHERE id IN (SELECT id FROM model_outputs WHERE status='failed')
          AND NOT EXISTS (SELECT 1 FROM models WHERE models.id=model_versions.model_id AND models.active_version_id=model_versions.id);
      UPDATE model_outputs SET status='staged'
        WHERE status='ready'
          AND attempt_id IN (SELECT id FROM processing_attempts WHERE status IN ('ingesting','derivatives'))
          AND NOT EXISTS (SELECT 1 FROM models WHERE models.id=model_outputs.model_id AND models.active_version_id=model_outputs.id);
      UPDATE model_versions SET status='importing'
        WHERE id IN (SELECT id FROM model_outputs WHERE status='staged')
          AND NOT EXISTS (SELECT 1 FROM models WHERE models.id=model_versions.model_id AND models.active_version_id=model_versions.id);
      DROP TABLE model_outputs_v15;
      CREATE INDEX model_outputs_page_idx ON model_outputs(created_at DESC,id DESC);
      CREATE INDEX model_outputs_project_page_idx ON model_outputs(project_id,created_at DESC,id DESC);
      CREATE INDEX model_outputs_task_page_idx ON model_outputs(task_id,created_at DESC,id DESC);
      CREATE INDEX model_outputs_status_page_idx ON model_outputs(status,created_at DESC,id DESC);
      CREATE TABLE task_draft_requests (
        subject TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(subject,submission_id)
      );
      CREATE TRIGGER processing_attempt_output_failed
      AFTER UPDATE OF status ON processing_attempts
      WHEN NEW.status IN ('failed','cancelled') AND NEW.result_model_version_id IS NOT NULL
      BEGIN
        UPDATE model_outputs SET status='failed',updated_at=NEW.updated_at
          WHERE id=NEW.result_model_version_id AND attempt_id=NEW.id AND status IN ('staged','ready');
        UPDATE model_versions SET status='failed',updated_at=NEW.updated_at
          WHERE id=NEW.result_model_version_id AND model_id=NEW.result_model_id
            AND EXISTS (SELECT 1 FROM model_outputs WHERE id=NEW.result_model_version_id AND status='failed')
            AND NOT EXISTS (SELECT 1 FROM models WHERE id=NEW.result_model_id AND active_version_id=NEW.result_model_version_id);
        UPDATE models SET status='failed',updated_at=NEW.updated_at
          WHERE id=NEW.result_model_id AND active_version_id IS NULL
            AND EXISTS (SELECT 1 FROM model_outputs WHERE id=NEW.result_model_version_id AND status='failed');
      END;
      CREATE TRIGGER storage_mutation_audit_complete
      AFTER UPDATE OF status ON storage_mutations
      WHEN OLD.status<>'complete' AND NEW.status='complete'
      BEGIN
        INSERT INTO audit_events(id,actor_type,actor_id,action,entity_type,entity_id,details_json,created_at)
        VALUES (lower(hex(randomblob(16))),'admin',NEW.actor,
          NEW.entity_type||'.'||CASE NEW.mutation_type WHEN 'trash' THEN 'trashed' WHEN 'restore' THEN 'restored' ELSE 'purged' END,
          NEW.entity_type,NEW.entity_id,
          json_object('mutationId',NEW.id,'trashId',NEW.trash_id),NEW.updated_at);
      END;
    `,
  },
  {
    version: 17,
    name: 'published_session_source_authorizations',
    sql: `
      ALTER TABLE session_grants ADD COLUMN source_authorization_type TEXT
        CHECK(source_authorization_type IS NULL OR source_authorization_type='model_association');
      ALTER TABLE session_grants ADD COLUMN source_authorization_id TEXT;
      ALTER TABLE session_grants ADD COLUMN source_authorization_version INTEGER
        CHECK(source_authorization_version IS NULL OR source_authorization_version >= 1);
      CREATE INDEX session_grants_source_authorization_idx
        ON session_grants(source_authorization_type,source_authorization_id,source_authorization_version,session_mode,redeemed_at)
        WHERE source_authorization_id IS NOT NULL;

      ALTER TABLE viewer_sessions ADD COLUMN source_authorization_type TEXT
        CHECK(source_authorization_type IS NULL OR source_authorization_type='model_association');
      ALTER TABLE viewer_sessions ADD COLUMN source_authorization_id TEXT;
      ALTER TABLE viewer_sessions ADD COLUMN source_authorization_version INTEGER
        CHECK(source_authorization_version IS NULL OR source_authorization_version >= 1);
      CREATE INDEX viewer_sessions_source_authorization_idx
        ON viewer_sessions(source_authorization_type,source_authorization_id,source_authorization_version,session_mode,revoked_at,expires_at)
        WHERE source_authorization_id IS NOT NULL;
      CREATE TABLE revoked_published_session_authorizations (
        source_authorization_type TEXT NOT NULL CHECK(source_authorization_type='model_association'),
        source_authorization_id TEXT NOT NULL,
        source_authorization_version INTEGER NOT NULL CHECK(source_authorization_version >= 1),
        revoked_at TEXT NOT NULL,
        revoked_by TEXT,
        PRIMARY KEY(source_authorization_type,source_authorization_id,source_authorization_version)
      );
      CREATE TRIGGER session_grants_source_authorization_complete_insert
      BEFORE INSERT ON session_grants
      WHEN (NEW.source_authorization_type IS NULL) + (NEW.source_authorization_id IS NULL)
        + (NEW.source_authorization_version IS NULL) NOT IN (0,3)
      BEGIN SELECT RAISE(ABORT,'source_authorization_incomplete'); END;
      CREATE TRIGGER session_grants_source_authorization_immutable
      BEFORE UPDATE OF source_authorization_type,source_authorization_id,source_authorization_version ON session_grants
      WHEN NEW.source_authorization_type IS NOT OLD.source_authorization_type
        OR NEW.source_authorization_id IS NOT OLD.source_authorization_id
        OR NEW.source_authorization_version IS NOT OLD.source_authorization_version
      BEGIN SELECT RAISE(ABORT,'source_authorization_immutable'); END;
      CREATE TRIGGER viewer_sessions_source_authorization_complete_insert
      BEFORE INSERT ON viewer_sessions
      WHEN (NEW.source_authorization_type IS NULL) + (NEW.source_authorization_id IS NULL)
        + (NEW.source_authorization_version IS NULL) NOT IN (0,3)
      BEGIN SELECT RAISE(ABORT,'source_authorization_incomplete'); END;
      CREATE TRIGGER viewer_sessions_source_authorization_immutable
      BEFORE UPDATE OF source_authorization_type,source_authorization_id,source_authorization_version ON viewer_sessions
      WHEN NEW.source_authorization_type IS NOT OLD.source_authorization_type
        OR NEW.source_authorization_id IS NOT OLD.source_authorization_id
        OR NEW.source_authorization_version IS NOT OLD.source_authorization_version
      BEGIN SELECT RAISE(ABORT,'source_authorization_immutable'); END;

      -- Existing grants/sessions cannot be safely attributed to a model
      -- association. Fail closed instead of inventing an authorization source.
      DELETE FROM session_grants
        WHERE session_mode='published' AND redeemed_at IS NULL
          AND source_authorization_id IS NULL;
      UPDATE viewer_sessions SET revoked_at=COALESCE(revoked_at,datetime('now')),updated_at=datetime('now')
        WHERE session_mode='published' AND revoked_at IS NULL
          AND datetime(expires_at)>datetime('now') AND source_authorization_id IS NULL;
    `,
  },
  {
    version: 18,
    name: 'durable_webodm_task_migrations',
    sql: `
      CREATE TABLE webodm_task_imports (
        id TEXT PRIMARY KEY,
        source_fingerprint TEXT NOT NULL UNIQUE CHECK(length(source_fingerprint)=64),
        source_relative_path TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id TEXT NOT NULL REFERENCES processing_tasks(id) ON DELETE RESTRICT,
        dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
        attempt_id TEXT NOT NULL REFERENCES processing_attempts(id) ON DELETE RESTRICT,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        model_version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
        asset_kinds_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX webodm_task_imports_project_idx ON webodm_task_imports(project_id,created_at DESC);
    `,
  },
  {
    version: 19,
    name: 'gcp_provenance_ranking_and_snapshot_integrity',
    sql: `
      CREATE TABLE gcp_import_provenance (
        set_id TEXT PRIMARY KEY REFERENCES gcp_sets(id) ON DELETE CASCADE,
        adapter TEXT NOT NULL,
        coordinate_system TEXT NOT NULL,
        vertical_datum TEXT NOT NULL,
        linear_unit TEXT NOT NULL CHECK(linear_unit IN ('m','ftUS')),
        elevation_source TEXT,
        geographic_cross_check TEXT,
        source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
        confirmed_by TEXT,
        confirmed_at TEXT NOT NULL
      );
      ALTER TABLE gcp_points ADD COLUMN easting REAL;
      ALTER TABLE gcp_points ADD COLUMN northing REAL;
      ALTER TABLE gcp_points ADD COLUMN ellipsoidal_height_m REAL;
      CREATE TABLE gcp_image_ranking_metadata (
        dataset_file_id TEXT PRIMARY KEY REFERENCES dataset_files(id) ON DELETE CASCADE,
        horizontal_accuracy_m REAL CHECK(horizontal_accuracy_m IS NULL OR horizontal_accuracy_m >= 0),
        heading_deg REAL CHECK(heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg < 360)),
        field_of_view_deg REAL CHECK(field_of_view_deg IS NULL OR (field_of_view_deg > 0 AND field_of_view_deg < 180)),
        footprint_radius_m REAL CHECK(footprint_radius_m IS NULL OR footprint_radius_m > 0),
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TRIGGER processing_attempt_gcp_snapshot_no_update
      BEFORE UPDATE ON processing_attempt_gcp_snapshots
      BEGIN SELECT RAISE(ABORT,'gcp_snapshot_immutable'); END;
      CREATE TRIGGER processing_attempt_gcp_snapshot_no_delete
      BEFORE DELETE ON processing_attempt_gcp_snapshots
      WHEN EXISTS (SELECT 1 FROM processing_attempts WHERE id=OLD.attempt_id)
      BEGIN SELECT RAISE(ABORT,'gcp_snapshot_immutable'); END;
    `,
  },
  {
    version: 20,
    name: 'public_project_shares',
    sql: `
      CREATE TABLE public_project_shares (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        public_id_hash TEXT NOT NULL UNIQUE CHECK(length(public_id_hash)=64),
        password_hash TEXT,
        permissions_json TEXT NOT NULL,
        label TEXT,
        version_policy TEXT NOT NULL DEFAULT 'active'
          CHECK(version_policy='active'),
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        display_units TEXT NOT NULL DEFAULT 'imperial'
          CHECK(display_units IN ('imperial','metric')),
        revoked_at TEXT,
        revoked_by TEXT,
        revoke_reason TEXT,
        access_count INTEGER NOT NULL DEFAULT 0 CHECK(access_count >= 0),
        last_accessed_at TEXT
      );
      CREATE INDEX public_project_shares_project_idx
        ON public_project_shares(project_id,created_at DESC);
      CREATE INDEX public_project_shares_live_idx
        ON public_project_shares(project_id,revoked_at,expires_at);
    `,
  },
  {
    version: 21,
    name: 'camera_photo_links',
    sql: `
      CREATE TABLE model_camera_photos (
        version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        root_key TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content_type TEXT NOT NULL CHECK(content_type='image/jpeg'),
        byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
        sha256 TEXT NOT NULL CHECK(length(sha256)=64),
        created_at TEXT NOT NULL,
        PRIMARY KEY(version_id,filename)
      );
      CREATE INDEX model_camera_photos_version_idx
        ON model_camera_photos(version_id,filename);
    `,
  },
  {
    version: 22,
    name: 'container_trash_members',
    sql: `
      CREATE TABLE container_trash_members (
        container_trash_id TEXT NOT NULL REFERENCES storage_trash(id) ON DELETE RESTRICT,
        member_trash_id TEXT NOT NULL REFERENCES storage_trash(id) ON DELETE RESTRICT,
        entity_type TEXT NOT NULL CHECK(entity_type IN ('project','task','dataset','output')),
        entity_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(container_trash_id,member_trash_id),
        UNIQUE(container_trash_id,entity_type,entity_id)
      );
      CREATE INDEX container_trash_members_member_idx ON container_trash_members(member_trash_id);
    `,
  },
];

function applyMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  for (const migration of MIGRATIONS) {
    database.exec('BEGIN IMMEDIATE');
    try {
      // Re-check only after holding SQLite's write reservation. The API and
      // worker can start against the same fresh/upgraded volume concurrently;
      // a pre-lock snapshot would let the waiter apply an already-committed
      // ALTER TABLE a second time.
      const applied = database.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(migration.version);
      if (applied) {
        database.exec('COMMIT');
        continue;
      }
      database.exec(migration.sql);
      database.prepare(
        'INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)',
      ).run(migration.version, migration.name, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

function withBusyRetry(operation, timeoutMs = 5000) {
  const startedAt = Date.now();
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { return operation(); }
    catch (error) {
      const busy = error?.errcode === 5 || error?.code === 'SQLITE_BUSY' || /database is locked/i.test(error?.message ?? '');
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (!busy || remaining <= 0) throw error;
      Atomics.wait(sleeper, 0, 0, Math.min(25, remaining));
    }
  }
}

function openDatabase(databasePath) {
  if (!databasePath) throw new Error('databasePath is required');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  // Set the lock wait before journal-mode initialization so two first-boot
  // processes do not fail while one establishes the WAL files.
  database.exec('PRAGMA busy_timeout=5000');
  database.exec('PRAGMA foreign_keys=ON');
  // SQLite's journal-mode transition may return SQLITE_BUSY without invoking
  // the configured busy handler during simultaneous first boot. Retry only
  // that bounded initialization transition; migration locking remains native.
  withBusyRetry(() => database.exec('PRAGMA journal_mode=WAL'));
  database.exec('PRAGMA synchronous=NORMAL');
  applyMigrations(database);
  return database;
}

module.exports = { MIGRATIONS, applyMigrations, openDatabase };
