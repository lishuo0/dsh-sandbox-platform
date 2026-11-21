-- 本地 SQLite 版 schema。列语义与 schema.sql 相同：
-- jsonb → text、text[] → text（存 JSON）、bytea → blob、boolean → integer、timestamptz → text。

CREATE TABLE IF NOT EXISTS dsh_users (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'active',
  -- 管理员开户、重置密码后置 1；成员改过自己的密码才清掉。
  must_change_password integer NOT NULL DEFAULT 0,
  skills_volume text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS dsh_user_models (
  user_id text PRIMARY KEY REFERENCES dsh_users(id) ON DELETE CASCADE,
  base_url text NOT NULL,
  api text NOT NULL DEFAULT 'openai-completions',
  model_ids text NOT NULL,
  default_model text NOT NULL,
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 一个成员可配多个模型提供商；密钥在 dsh_user_credentials，name = 本表 id。
CREATE TABLE IF NOT EXISTS dsh_user_model_providers (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  display_name text NOT NULL DEFAULT '',
  base_url text NOT NULL,
  api text NOT NULL DEFAULT 'openai-completions',
  model_ids text NOT NULL,
  default_model text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS dsh_user_model_providers_user
  ON dsh_user_model_providers (user_id, sort_order, id);

CREATE TABLE IF NOT EXISTS dsh_user_credentials (
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  ciphertext blob NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
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
  is_default integer NOT NULL DEFAULT 0,
  -- 成员手动拖拽后的显示顺序；0 表示没调过，沿用「默认工作区优先、最近活跃优先」。
  sort_order integer NOT NULL DEFAULT 0,
  -- 0 表示没配置过（沿用「全部启用」的旧行为）；1 时下面两张表就是权威列表，
  -- 允许为空——空表示这个工作区不接入任何 Skill / MCP。
  selection_configured integer NOT NULL DEFAULT 0,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_active_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 每个成员最多一个默认工作区；没带工作区的会话落到它上面。
CREATE UNIQUE INDEX IF NOT EXISTS dsh_workspaces_default ON dsh_workspaces (user_id) WHERE is_default;

-- 工作区明确选择的技能；技能按 (name, scope) 引用，公开技能人人可选。
CREATE TABLE IF NOT EXISTS dsh_workspace_skills (
  workspace_id text NOT NULL REFERENCES dsh_workspaces(id) ON DELETE CASCADE,
  skill_name text NOT NULL,
  skill_scope text NOT NULL CHECK (skill_scope IN ('private', 'public')),
  PRIMARY KEY (workspace_id, skill_name, skill_scope)
);

-- 工作区明确选择的 MCP server；规则与技能一致。
CREATE TABLE IF NOT EXISTS dsh_workspace_mcp_servers (
  workspace_id text NOT NULL REFERENCES dsh_workspaces(id) ON DELETE CASCADE,
  server_name text NOT NULL,
  server_scope text NOT NULL CHECK (server_scope IN ('private', 'public')),
  PRIMARY KEY (workspace_id, server_name, server_scope)
);

-- 会话必须挂在某块工作区上；平台在写入、建会话、启动回填时保证 workspace_id 非空。
-- 列仍允许 NULL，是因为老库无法原地收紧：读到 NULL 会补到成员默认工作区。
CREATE TABLE IF NOT EXISTS dsh_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  workspace_id text REFERENCES dsh_workspaces(id) ON DELETE SET NULL,
  preset_id text,
  title text,
  status text NOT NULL DEFAULT 'active',
  model_id text,
  -- 工作区内的手动顺序与置顶；0 / NULL 表示沿用「最近创建优先」。
  sort_order integer NOT NULL DEFAULT 0,
  pinned_at text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_active_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS dsh_platform_session_ops (
  session_id text PRIMARY KEY REFERENCES dsh_sessions(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  state text NOT NULL,
  error_code text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS dsh_platform_message_requests (
  session_id text NOT NULL REFERENCES dsh_sessions(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  user_id text NOT NULL,
  digest text NOT NULL,
  state text NOT NULL,
  error_code text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (session_id, request_id)
);

-- 平台是唯一的排队者：会话的待发送消息只存在这里，不写进脑的 inbox。
CREATE TABLE IF NOT EXISTS dsh_session_queue (
  session_id text NOT NULL REFERENCES dsh_sessions(id) ON DELETE CASCADE,
  item_id text NOT NULL,
  request_id text NOT NULL,
  user_id text NOT NULL,
  content text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (session_id, item_id)
);

CREATE INDEX IF NOT EXISTS dsh_session_queue_order_idx
  ON dsh_session_queue (session_id, created_at);

-- 脑写、平台只读。DDL 与 dsh-sandbox-brain/src/schema.sqlite.sql 保持一致；
-- 平台用它推导标题、blank/running 和历史页，所以平台侧也要能建出这张表。
CREATE TABLE IF NOT EXISTS dsh_session_events (
  session_id text NOT NULL,
  seq integer NOT NULL,
  event text NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS dsh_skills (
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL,
  scope text NOT NULL DEFAULT 'private' CHECK (scope IN ('private', 'public')),
  group_id text,
  enabled integer NOT NULL DEFAULT 1,
  revision integer NOT NULL DEFAULT 1,
  bytes integer NOT NULL DEFAULT 0,
  file_count integer NOT NULL DEFAULT 0,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS dsh_skills_public_name ON dsh_skills (name) WHERE scope = 'public';

-- 技能 / MCP 分组：平台自己的组织方式，成员按 group_id 归属；
-- 工作区选中的分组会把成员展开到 dsh_workspace_skills / dsh_workspace_mcp_servers，
-- 脑仍然只读那两张表。
CREATE TABLE IF NOT EXISTS dsh_skill_groups (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS dsh_mcp_groups (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS dsh_workspace_skill_groups (
  workspace_id text NOT NULL REFERENCES dsh_workspaces(id) ON DELETE CASCADE,
  group_id text NOT NULL,
  PRIMARY KEY (workspace_id, group_id)
);

CREATE TABLE IF NOT EXISTS dsh_workspace_mcp_groups (
  workspace_id text NOT NULL REFERENCES dsh_workspaces(id) ON DELETE CASCADE,
  group_id text NOT NULL,
  PRIMARY KEY (workspace_id, group_id)
);

CREATE TABLE IF NOT EXISTS dsh_mcp_servers (
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  server_name text NOT NULL,
  transport text NOT NULL,
  target text NOT NULL,
  config text NOT NULL DEFAULT '{}',
  scope text NOT NULL DEFAULT 'private' CHECK (scope IN ('private', 'public')),
  group_id text,
  enabled integer NOT NULL DEFAULT 1,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, server_name)
);

CREATE UNIQUE INDEX IF NOT EXISTS dsh_mcp_servers_public_name
  ON dsh_mcp_servers (server_name) WHERE scope = 'public';

CREATE TABLE IF NOT EXISTS dsh_schedule_tasks (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  title text NOT NULL,
  prompt text NOT NULL,
  kind text NOT NULL,
  rule text NOT NULL,
  generation integer NOT NULL DEFAULT 1,
  status text NOT NULL,
  desired_at text NOT NULL,
  next_run_at text NOT NULL,
  lease_owner text,
  lease_until text,
  last_request_id text,
  last_delivery text,
  attempt_count integer NOT NULL DEFAULT 0,
  pending_occurrence text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS dsh_schedule_tasks_due_idx
  ON dsh_schedule_tasks (next_run_at)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS dsh_attachments (
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  media_type text NOT NULL,
  bytes integer NOT NULL,
  object_key text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, id)
);

-- 从脑写的 dsh_session_events 投影出来的计价用量。平台只写这张表和游标。
CREATE TABLE IF NOT EXISTS dsh_usage_steps (
  session_id text NOT NULL,
  seq integer NOT NULL,
  user_id text NOT NULL,
  workspace_id text NOT NULL,
  at text NOT NULL,
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  input_tokens integer NOT NULL DEFAULT 0,
  cache_read_tokens integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  price_version text,
  amount real,
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX IF NOT EXISTS dsh_usage_steps_user_at
  ON dsh_usage_steps (user_id, at);

CREATE TABLE IF NOT EXISTS dsh_usage_cursors (
  session_id text PRIMARY KEY,
  seq integer NOT NULL DEFAULT 0
);

-- ---- 工单自动化（superagent） -------------------------------------------

-- 成员自己接入的渠道：飞书机器人 / GitHub App。凭据属于成员本人，管理员不代配。
CREATE TABLE IF NOT EXISTS dsh_superagent_channels (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('feishu', 'github')),
  name text NOT NULL DEFAULT '',
  app_id text NOT NULL,
  -- 新建绑定时继承的默认接活规则（每个元素一句大白话）；单个绑定仍可覆盖。
  default_rules text NOT NULL DEFAULT '[]',
  secret_ciphertext blob NOT NULL,
  secret_key_version integer NOT NULL DEFAULT 1,
  config text NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'error')),
  last_error text,
  last_event_at text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, provider, app_id)
);

-- 一个群绑定一块工作区。绑定属于成员：同一个人一个群只能绑一块工作区，
-- 不同成员可以各自绑同一个群、各自看到自己的工单。
CREATE TABLE IF NOT EXISTS dsh_superagent_bindings (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  channel_id text NOT NULL REFERENCES dsh_superagent_channels(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES dsh_workspaces(id) ON DELETE CASCADE,
  external_chat_id text NOT NULL,
  chat_name text NOT NULL DEFAULT '',
  policy text NOT NULL DEFAULT '{}',
  policy_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, channel_id, external_chat_id)
);

CREATE INDEX IF NOT EXISTS dsh_superagent_bindings_lookup
  ON dsh_superagent_bindings (channel_id, external_chat_id, status);

-- 收到的每条消息先落这里再做去重：同一条消息重投不能接两次活。
CREATE TABLE IF NOT EXISTS dsh_superagent_messages (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  binding_id text NOT NULL REFERENCES dsh_superagent_bindings(id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  external_chat_id text NOT NULL,
  external_message_id text NOT NULL,
  thread_key text NOT NULL,
  sender_id text NOT NULL DEFAULT '',
  sender_name text NOT NULL DEFAULT '',
  body text NOT NULL,
  addressed integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'ignored', 'skipped', 'failed')),
  prompt_version text,
  provider text,
  model text,
  input_tokens integer,
  output_tokens integer,
  decision text,
  last_error text,
  received_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  evaluated_at text,
  UNIQUE (channel_id, external_message_id)
);

CREATE INDEX IF NOT EXISTS dsh_superagent_messages_pending
  ON dsh_superagent_messages (binding_id, status, received_at);

CREATE TABLE IF NOT EXISTS dsh_superagent_tickets (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  binding_id text NOT NULL REFERENCES dsh_superagent_bindings(id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  workspace_id text NOT NULL,
  thread_key text NOT NULL,
  external_root_id text,
  title text NOT NULL,
  scope text NOT NULL,
  reason text NOT NULL,
  intent_evidence text NOT NULL,
  rules text NOT NULL DEFAULT '[]',
  stage text NOT NULL DEFAULT 'accepted'
    CHECK (stage IN ('accepted', 'working', 'review', 'done', 'failed', 'stopped')),
  session_id text,
  message_id text,
  auto_merge integer NOT NULL DEFAULT 0,
  outcome text NOT NULL DEFAULT '{}',
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  closed_at text
);

CREATE INDEX IF NOT EXISTS dsh_superagent_tickets_owner
  ON dsh_superagent_tickets (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS dsh_superagent_tickets_thread
  ON dsh_superagent_tickets (binding_id, thread_key, stage);

CREATE TABLE IF NOT EXISTS dsh_superagent_assignments (
  id text PRIMARY KEY,
  ticket_id text NOT NULL REFERENCES dsh_superagent_tickets(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  generation integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  session_id text,
  lease_owner text,
  lease_until text,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  started_at text,
  finished_at text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS dsh_superagent_assignments_due
  ON dsh_superagent_assignments (status, lease_until);

CREATE INDEX IF NOT EXISTS dsh_superagent_assignments_ticket
  ON dsh_superagent_assignments (ticket_id, generation DESC);

CREATE TABLE IF NOT EXISTS dsh_superagent_outbox (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
  channel_id text NOT NULL REFERENCES dsh_superagent_channels(id) ON DELETE CASCADE,
  external_chat_id text NOT NULL,
  thread_root_id text,
  kind text NOT NULL CHECK (kind IN ('reply', 'ack', 'report', 'decline')),
  body text NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'dead')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  lease_owner text,
  lease_until text,
  last_error text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sent_at text
);

CREATE INDEX IF NOT EXISTS dsh_superagent_outbox_due
  ON dsh_superagent_outbox (status, next_attempt_at);
