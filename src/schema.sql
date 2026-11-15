CREATE TABLE IF NOT EXISTS dsh_users (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'active',
  skills_volume text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dsh_user_models (
  user_id text PRIMARY KEY REFERENCES dsh_users(id) ON DELETE CASCADE,
  base_url text NOT NULL,
  api text NOT NULL DEFAULT 'openai-completions',
  model_ids text[] NOT NULL,
  default_model text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dsh_user_credentials (
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  ciphertext bytea NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, name)
);

CREATE TABLE IF NOT EXISTS dsh_workspaces (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  name text NOT NULL,
  host_root text NOT NULL,
  guest_root text NOT NULL,
  volume_name text,
  state text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dsh_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  workspace_id text REFERENCES dsh_workspaces(id) ON DELETE SET NULL,
  preset_id text,
  title text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dsh_platform_session_ops (
  session_id text PRIMARY KEY REFERENCES dsh_sessions(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  state text NOT NULL,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dsh_platform_message_requests (
  session_id text NOT NULL REFERENCES dsh_sessions(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  user_id text NOT NULL,
  digest text NOT NULL,
  state text NOT NULL,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, request_id)
);

CREATE TABLE IF NOT EXISTS dsh_skills (
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL,
  scope text NOT NULL DEFAULT 'private' CHECK (scope IN ('private', 'public')),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  bytes bigint NOT NULL DEFAULT 0,
  file_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS dsh_skills_public_name ON dsh_skills (name) WHERE scope = 'public';

CREATE TABLE IF NOT EXISTS dsh_mcp_servers (
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  server_name text NOT NULL,
  transport text NOT NULL,
  target text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, server_name)
);

CREATE TABLE IF NOT EXISTS dsh_schedule_tasks (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  title text NOT NULL,
  prompt text NOT NULL,
  kind text NOT NULL,
  rule jsonb NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  status text NOT NULL,
  desired_at timestamptz NOT NULL,
  next_run_at timestamptz NOT NULL,
  lease_owner text,
  lease_until timestamptz,
  last_request_id text,
  last_delivery text,
  attempt_count integer NOT NULL DEFAULT 0,
  pending_occurrence timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dsh_schedule_tasks_due_idx
  ON dsh_schedule_tasks (next_run_at)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS dsh_attachments (
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  media_type text NOT NULL,
  bytes bigint NOT NULL,
  object_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
