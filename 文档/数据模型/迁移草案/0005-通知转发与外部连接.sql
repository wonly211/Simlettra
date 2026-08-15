-- 澄笺 | Simlettra 第五批数据模型验证性迁移草案
--
-- 适用范围：空白验证数据库。前四批尚未进入生产，本草案会重建第三批中
-- 假定“每封外发邮件只有一家 Provider”的临时表。正式工程建立后，必须把
-- 0001 至 0005 整理为连续、可升级的 Wrangler 迁移，不得直接用于生产升级。

PRAGMA foreign_keys = ON;

-- 先移除第三批的单一 Provider 模型。按子表到父表顺序删除，以保持外键检查有效。
DROP TABLE provider_attempt_recipients;
DROP TABLE provider_events;
DROP TABLE send_recipient_status_history;
DROP TABLE provider_submission_attempts;
DROP TABLE send_idempotency_keys;
DROP TABLE send_recipients;
DROP TABLE send_operations;

-- 管理员维护的版本化站外发信服务。敏感凭据只保存认证加密后的密文。
CREATE TABLE outbound_provider_configs (
    id TEXT PRIMARY KEY NOT NULL,
    configuration_key TEXT NOT NULL CHECK (length(configuration_key) > 0),
    configuration_version INTEGER NOT NULL CHECK (configuration_version >= 1),
    provider_type TEXT NOT NULL CHECK (
        provider_type IN ('resend', 'smtp2go')
    ),
    public_options_json TEXT NOT NULL CHECK (json_valid(public_options_json)),
    credential_ciphertext BLOB NOT NULL CHECK (length(credential_ciphertext) > 0),
    credential_nonce BLOB NOT NULL CHECK (length(credential_nonce) = 12),
    credential_algorithm TEXT NOT NULL CHECK (credential_algorithm = 'AES-GCM-256'),
    credential_key_version INTEGER NOT NULL CHECK (credential_key_version >= 1),
    credential_updated_at INTEGER NOT NULL,
    configuration_status TEXT NOT NULL CHECK (
        configuration_status IN ('active', 'disabled', 'retired')
    ),
    disabled_at INTEGER,
    retired_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (configuration_key, configuration_version),
    CHECK (updated_at >= created_at),
    CHECK (
        (configuration_status = 'active' AND disabled_at IS NULL AND retired_at IS NULL)
        OR (configuration_status = 'disabled' AND disabled_at IS NOT NULL AND retired_at IS NULL)
        OR (configuration_status = 'retired' AND retired_at IS NOT NULL)
    )
);

CREATE INDEX outbound_provider_configs_status_index
    ON outbound_provider_configs (provider_type, configuration_status, configuration_key, configuration_version DESC);

CREATE TRIGGER prevent_outbound_provider_config_identity_change
BEFORE UPDATE OF
    configuration_key,
    configuration_version,
    provider_type,
    public_options_json,
    credential_ciphertext,
    credential_nonce,
    credential_algorithm,
    credential_key_version,
    credential_updated_at,
    created_at
ON outbound_provider_configs
BEGIN
    SELECT RAISE(ABORT, '服务配置版本与加密凭据不可原地修改');
END;

-- 每个域名同一时刻最多启用一条路线；路线中的第一项是默认服务，之后为备用服务。
CREATE TABLE domain_outbound_routes (
    id TEXT PRIMARY KEY NOT NULL,
    mail_domain_id TEXT NOT NULL,
    route_version INTEGER NOT NULL CHECK (route_version >= 1),
    route_status TEXT NOT NULL CHECK (
        route_status IN ('draft', 'active', 'superseded', 'disabled')
    ),
    created_at INTEGER NOT NULL,
    activated_at INTEGER,
    superseded_at INTEGER,
    disabled_at INTEGER,
    updated_at INTEGER NOT NULL,
    UNIQUE (mail_domain_id, route_version),
    CHECK (updated_at >= created_at),
    CHECK (
        (route_status = 'draft' AND activated_at IS NULL AND superseded_at IS NULL AND disabled_at IS NULL)
        OR (route_status = 'active' AND activated_at IS NOT NULL AND superseded_at IS NULL AND disabled_at IS NULL)
        OR (route_status = 'superseded' AND activated_at IS NOT NULL AND superseded_at IS NOT NULL)
        OR (route_status = 'disabled' AND disabled_at IS NOT NULL)
    ),
    FOREIGN KEY (mail_domain_id) REFERENCES mail_domains (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX domain_outbound_routes_active_unique
    ON domain_outbound_routes (mail_domain_id)
    WHERE route_status = 'active';

CREATE INDEX domain_outbound_routes_domain_index
    ON domain_outbound_routes (mail_domain_id, route_version DESC);

CREATE TRIGGER prevent_domain_outbound_route_identity_change
BEFORE UPDATE OF mail_domain_id, route_version, created_at
ON domain_outbound_routes
BEGIN
    SELECT RAISE(ABORT, '域名发信路线身份不可修改');
END;

CREATE TRIGGER validate_domain_outbound_route_transition
BEFORE UPDATE OF route_status ON domain_outbound_routes
WHEN NEW.route_status <> OLD.route_status
  AND NOT (
      (OLD.route_status = 'draft' AND NEW.route_status IN ('active', 'disabled'))
      OR (OLD.route_status = 'active' AND NEW.route_status IN ('superseded', 'disabled'))
  )
BEGIN
    SELECT RAISE(ABORT, '域名发信路线状态不可倒退或重开');
END;

CREATE TABLE domain_outbound_route_entries (
    id TEXT PRIMARY KEY NOT NULL,
    route_id TEXT NOT NULL,
    priority_number INTEGER NOT NULL CHECK (priority_number >= 0),
    provider_config_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (route_id, priority_number),
    UNIQUE (route_id, provider_config_id),
    FOREIGN KEY (route_id) REFERENCES domain_outbound_routes (id) ON DELETE CASCADE,
    FOREIGN KEY (provider_config_id) REFERENCES outbound_provider_configs (id) ON DELETE RESTRICT
);

CREATE INDEX domain_outbound_route_entries_config_index
    ON domain_outbound_route_entries (provider_config_id, route_id);

CREATE TRIGGER validate_domain_outbound_route_entry_insert
BEFORE INSERT ON domain_outbound_route_entries
WHEN NOT EXISTS (
    SELECT 1
    FROM domain_outbound_routes AS route
    JOIN outbound_provider_configs AS config ON config.id = NEW.provider_config_id
    WHERE route.id = NEW.route_id
      AND route.route_status = 'draft'
      AND config.configuration_status = 'active'
)
BEGIN
    SELECT RAISE(ABORT, '只有草稿路线可以加入已启用的服务配置');
END;

CREATE TRIGGER prevent_domain_outbound_route_entry_change
BEFORE UPDATE ON domain_outbound_route_entries
BEGIN
    SELECT RAISE(ABORT, '发信路线条目不可修改，请建立新路线版本');
END;

CREATE TRIGGER validate_domain_outbound_route_activation
BEFORE UPDATE OF route_status ON domain_outbound_routes
WHEN OLD.route_status = 'draft'
  AND NEW.route_status = 'active'
  AND NOT EXISTS (
      SELECT 1 FROM domain_outbound_route_entries WHERE route_id = NEW.id
  )
BEGIN
    SELECT RAISE(ABORT, '启用发信路线前必须至少配置一家服务');
END;

-- 每个需要站外发送的执行对象在接受时冻结路线；快照不保存密钥。
CREATE TABLE outbound_route_snapshots (
    id TEXT PRIMARY KEY NOT NULL,
    mail_domain_id TEXT NOT NULL,
    source_route_id TEXT NOT NULL,
    source_route_version INTEGER NOT NULL CHECK (source_route_version >= 1),
    execution_kind TEXT NOT NULL CHECK (
        execution_kind IN ('send', 'forward', 'external_email_verification')
    ),
    execution_reference TEXT NOT NULL CHECK (length(execution_reference) > 0),
    payload_sha256 BLOB NOT NULL CHECK (length(payload_sha256) = 32),
    payload_size_bytes INTEGER NOT NULL CHECK (payload_size_bytes >= 0),
    created_at INTEGER NOT NULL,
    UNIQUE (execution_kind, execution_reference),
    FOREIGN KEY (mail_domain_id) REFERENCES mail_domains (id) ON DELETE RESTRICT,
    FOREIGN KEY (source_route_id) REFERENCES domain_outbound_routes (id) ON DELETE RESTRICT
);

CREATE INDEX outbound_route_snapshots_route_index
    ON outbound_route_snapshots (source_route_id, created_at DESC, id DESC);

CREATE TRIGGER validate_outbound_route_snapshot_insert
BEFORE INSERT ON outbound_route_snapshots
WHEN NOT EXISTS (
    SELECT 1
    FROM domain_outbound_routes AS route
    WHERE route.id = NEW.source_route_id
      AND route.mail_domain_id = NEW.mail_domain_id
      AND route.route_version = NEW.source_route_version
      AND route.route_status IN ('active', 'superseded', 'disabled')
)
BEGIN
    SELECT RAISE(ABORT, '路线快照必须来自对应域名的一条已完成路线');
END;

CREATE TRIGGER prevent_outbound_route_snapshot_change
BEFORE UPDATE ON outbound_route_snapshots
BEGIN
    SELECT RAISE(ABORT, '发信路线快照不可修改');
END;

CREATE TABLE outbound_route_snapshot_entries (
    id TEXT PRIMARY KEY NOT NULL,
    route_snapshot_id TEXT NOT NULL,
    priority_number INTEGER NOT NULL CHECK (priority_number >= 0),
    provider_config_id TEXT NOT NULL,
    configuration_key TEXT NOT NULL CHECK (length(configuration_key) > 0),
    configuration_version INTEGER NOT NULL CHECK (configuration_version >= 1),
    provider_type TEXT NOT NULL CHECK (
        provider_type IN ('resend', 'smtp2go')
    ),
    effective_size_limit_bytes INTEGER NOT NULL CHECK (effective_size_limit_bytes > 0),
    provider_options_digest BLOB NOT NULL CHECK (length(provider_options_digest) = 32),
    created_at INTEGER NOT NULL,
    UNIQUE (route_snapshot_id, priority_number),
    UNIQUE (route_snapshot_id, provider_config_id),
    FOREIGN KEY (route_snapshot_id) REFERENCES outbound_route_snapshots (id) ON DELETE CASCADE,
    FOREIGN KEY (provider_config_id) REFERENCES outbound_provider_configs (id) ON DELETE RESTRICT
);

CREATE INDEX outbound_route_snapshot_entries_provider_index
    ON outbound_route_snapshot_entries (provider_type, provider_config_id);

CREATE TRIGGER validate_outbound_route_snapshot_entry_insert
BEFORE INSERT ON outbound_route_snapshot_entries
WHEN NOT EXISTS (
    SELECT 1
    FROM outbound_provider_configs AS config
    WHERE config.id = NEW.provider_config_id
      AND config.configuration_key = NEW.configuration_key
      AND config.configuration_version = NEW.configuration_version
      AND config.provider_type = NEW.provider_type
)
BEGIN
    SELECT RAISE(ABORT, '路线快照条目与服务配置版本不匹配');
END;

CREATE TRIGGER prevent_outbound_route_snapshot_entry_change
BEFORE UPDATE ON outbound_route_snapshot_entries
BEGIN
    SELECT RAISE(ABORT, '冻结后的路线快照条目不可修改');
END;

-- 重新建立发送操作：保留既有发送边界，改为引用整条冻结路线而非单一 Provider。
CREATE TABLE send_operations (
    id TEXT PRIMARY KEY NOT NULL,
    operator_user_id TEXT NOT NULL,
    source_draft_id TEXT,
    source_draft_reference TEXT,
    source_draft_revision_number INTEGER CHECK (source_draft_revision_number >= 1),
    message_id TEXT NOT NULL UNIQUE,
    sent_mailbox_entry_id TEXT NOT NULL UNIQUE,
    sender_address_id TEXT NOT NULL,
    sender_address_binding_id TEXT NOT NULL,
    sent_mailbox_type TEXT NOT NULL CHECK (sent_mailbox_type IN ('user', 'organization')),
    sent_user_id TEXT,
    sent_organization_id TEXT,
    compose_kind TEXT NOT NULL CHECK (compose_kind IN ('new', 'reply', 'reply_all', 'forward')),
    source_message_id TEXT,
    source_reference TEXT,
    manual_retry_of_send_operation_id TEXT,
    manual_retry_of_reference TEXT,
    recipient_count INTEGER NOT NULL CHECK (recipient_count > 0),
    internal_recipient_count INTEGER NOT NULL CHECK (internal_recipient_count >= 0),
    external_recipient_count INTEGER NOT NULL CHECK (external_recipient_count >= 0),
    quota_recipient_units INTEGER NOT NULL CHECK (quota_recipient_units > 0),
    payload_sha256 BLOB NOT NULL CHECK (length(payload_sha256) = 32),
    payload_size_bytes INTEGER NOT NULL CHECK (payload_size_bytes >= 0),
    effective_size_limit_bytes INTEGER NOT NULL CHECK (effective_size_limit_bytes > 0),
    outbound_route_snapshot_id TEXT,
    workflow_status TEXT NOT NULL CHECK (workflow_status IN ('accepted', 'processing', 'finished')),
    accepted_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    final_mime_object_id TEXT NOT NULL UNIQUE,
    payload_generator_version TEXT NOT NULL CHECK (length(payload_generator_version) > 0),
    CHECK (updated_at >= created_at),
    CHECK (recipient_count = internal_recipient_count + external_recipient_count),
    CHECK (quota_recipient_units = recipient_count),
    CHECK (payload_size_bytes <= effective_size_limit_bytes),
    CHECK (
        (sent_mailbox_type = 'user' AND sent_user_id IS NOT NULL AND sent_organization_id IS NULL)
        OR (sent_mailbox_type = 'organization' AND sent_user_id IS NULL AND sent_organization_id IS NOT NULL)
    ),
    CHECK (
        (compose_kind = 'new' AND source_message_id IS NULL AND source_reference IS NULL)
        OR (compose_kind IN ('reply', 'reply_all', 'forward') AND source_reference IS NOT NULL AND length(source_reference) > 0)
    ),
    CHECK (
        (source_draft_reference IS NULL AND source_draft_id IS NULL AND source_draft_revision_number IS NULL)
        OR (source_draft_reference IS NOT NULL AND length(source_draft_reference) > 0 AND source_draft_id IS NOT NULL AND source_draft_revision_number IS NOT NULL)
    ),
    CHECK (
        (manual_retry_of_send_operation_id IS NULL AND manual_retry_of_reference IS NULL)
        OR (manual_retry_of_send_operation_id IS NOT NULL AND manual_retry_of_reference IS NOT NULL AND length(manual_retry_of_reference) > 0)
    ),
    CHECK (manual_retry_of_send_operation_id IS NULL OR manual_retry_of_send_operation_id <> id),
    CHECK (
        (external_recipient_count = 0 AND outbound_route_snapshot_id IS NULL)
        OR (external_recipient_count > 0 AND outbound_route_snapshot_id IS NOT NULL)
    ),
    FOREIGN KEY (operator_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    FOREIGN KEY (source_draft_id) REFERENCES drafts (id) ON DELETE SET NULL,
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT,
    FOREIGN KEY (sent_mailbox_entry_id) REFERENCES mailbox_entries (id) ON DELETE RESTRICT,
    FOREIGN KEY (sender_address_id) REFERENCES email_addresses (id) ON DELETE RESTRICT,
    FOREIGN KEY (sender_address_binding_id) REFERENCES address_bindings (id) ON DELETE RESTRICT,
    FOREIGN KEY (sent_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    FOREIGN KEY (sent_organization_id) REFERENCES organizations (id) ON DELETE RESTRICT,
    FOREIGN KEY (source_message_id) REFERENCES messages (id) ON DELETE SET NULL,
    FOREIGN KEY (manual_retry_of_send_operation_id) REFERENCES send_operations (id) ON DELETE SET NULL,
    FOREIGN KEY (outbound_route_snapshot_id) REFERENCES outbound_route_snapshots (id) ON DELETE RESTRICT,
    FOREIGN KEY (final_mime_object_id) REFERENCES object_registry (id) ON DELETE RESTRICT
);

CREATE INDEX send_operations_operator_index
    ON send_operations (operator_user_id, accepted_at DESC, id DESC);
CREATE INDEX send_operations_work_index
    ON send_operations (workflow_status, accepted_at, id);
CREATE INDEX send_operations_route_snapshot_index
    ON send_operations (outbound_route_snapshot_id)
    WHERE outbound_route_snapshot_id IS NOT NULL;

CREATE TRIGGER validate_send_operation_insert
BEFORE INSERT ON send_operations
WHEN NOT EXISTS (
    SELECT 1
    FROM users AS operator
    JOIN messages AS message
      ON message.id = NEW.message_id
     AND message.origin_type = 'composed'
     AND message.authored_by_user_id = NEW.operator_user_id
    JOIN mailbox_entries AS entry
      ON entry.id = NEW.sent_mailbox_entry_id
     AND entry.message_id = NEW.message_id
     AND entry.entry_kind = 'sent'
     AND entry.base_location = 'sent'
     AND entry.mailbox_type = NEW.sent_mailbox_type
     AND ((NEW.sent_mailbox_type = 'user' AND entry.user_id = NEW.sent_user_id)
       OR (NEW.sent_mailbox_type = 'organization' AND entry.organization_id = NEW.sent_organization_id))
    JOIN address_bindings AS binding
      ON binding.id = NEW.sender_address_binding_id
     AND binding.address_id = NEW.sender_address_id
     AND binding.started_at <= NEW.accepted_at
     AND (binding.ended_at IS NULL OR binding.ended_at >= NEW.accepted_at)
    JOIN email_addresses AS address ON address.id = NEW.sender_address_id
    JOIN mail_domains AS domain ON domain.id = address.domain_id AND domain.status = 'active'
    JOIN message_integrity_states AS integrity
      ON integrity.message_id = NEW.message_id
     AND integrity.integrity_status = 'ready'
     AND integrity.source_completeness = 'final_mime'
    JOIN object_registry AS object
      ON object.id = NEW.final_mime_object_id
     AND object.message_id = NEW.message_id
     AND object.object_role = 'final_mime'
     AND object.is_current = 1
     AND object.object_status = 'active'
     AND object.actual_size_bytes = NEW.payload_size_bytes
     AND object.actual_sha256 = NEW.payload_sha256
     AND object.producer_version = NEW.payload_generator_version
    LEFT JOIN outbound_route_snapshots AS snapshot
      ON snapshot.id = NEW.outbound_route_snapshot_id
     AND snapshot.execution_kind = 'send'
     AND snapshot.execution_reference = NEW.id
     AND snapshot.mail_domain_id = domain.id
     AND snapshot.payload_sha256 = NEW.payload_sha256
     AND snapshot.payload_size_bytes = NEW.payload_size_bytes
    WHERE operator.id = NEW.operator_user_id
      AND operator.status = 'active'
      AND ((NEW.external_recipient_count = 0 AND snapshot.id IS NULL)
        OR (NEW.external_recipient_count > 0 AND snapshot.id IS NOT NULL))
      AND (
          NEW.sent_mailbox_type = 'user'
          OR EXISTS (
              SELECT 1 FROM organizations AS organization
              WHERE organization.id = NEW.sent_organization_id
                AND organization.status = 'active'
                AND (organization.creator_user_id = NEW.operator_user_id
                  OR (organization.members_can_send = 1 AND EXISTS (
                      SELECT 1 FROM organization_memberships AS membership
                      WHERE membership.organization_id = organization.id
                        AND membership.user_id = NEW.operator_user_id
                        AND membership.left_at IS NULL
                  )))
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, '发送操作的权限、MIME或冻结路线无效');
END;

CREATE TRIGGER prevent_send_operation_identity_change
BEFORE UPDATE OF
    operator_user_id, source_draft_reference, source_draft_revision_number, message_id,
    sent_mailbox_entry_id, sender_address_id, sender_address_binding_id, sent_mailbox_type,
    sent_user_id, sent_organization_id, compose_kind, source_reference,
    manual_retry_of_reference, recipient_count, internal_recipient_count,
    external_recipient_count, quota_recipient_units, payload_sha256, payload_size_bytes,
    effective_size_limit_bytes, outbound_route_snapshot_id, accepted_at, created_at,
    final_mime_object_id, payload_generator_version
ON send_operations
BEGIN
    SELECT RAISE(ABORT, '已接受发送操作的冻结字段不可修改');
END;

CREATE TRIGGER validate_send_operation_workflow_transition
BEFORE UPDATE OF workflow_status ON send_operations
WHEN NEW.workflow_status <> OLD.workflow_status
  AND NOT (
      (OLD.workflow_status = 'accepted' AND NEW.workflow_status IN ('processing', 'finished'))
      OR (OLD.workflow_status = 'processing' AND NEW.workflow_status = 'finished')
  )
BEGIN
    SELECT RAISE(ABORT, '发送工作流状态不能倒退');
END;

CREATE TABLE send_idempotency_keys (
    user_id TEXT NOT NULL,
    request_key_digest BLOB NOT NULL CHECK (length(request_key_digest) = 32),
    input_digest BLOB NOT NULL CHECK (length(input_digest) = 32),
    send_operation_id TEXT NOT NULL UNIQUE,
    accepted_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, request_key_digest),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
    FOREIGN KEY (send_operation_id) REFERENCES send_operations (id) ON DELETE RESTRICT
);

CREATE TRIGGER validate_send_idempotency_key_insert
BEFORE INSERT ON send_idempotency_keys
WHEN NOT EXISTS (
    SELECT 1 FROM send_operations AS operation
    WHERE operation.id = NEW.send_operation_id
      AND operation.operator_user_id = NEW.user_id
      AND operation.accepted_at = NEW.accepted_at
)
BEGIN
    SELECT RAISE(ABORT, '发送幂等记录与发送操作不匹配');
END;

CREATE TRIGGER prevent_send_idempotency_key_change
BEFORE UPDATE ON send_idempotency_keys
BEGIN
    SELECT RAISE(ABORT, '发送幂等记录不可修改');
END;

CREATE TABLE send_recipients (
    id TEXT PRIMARY KEY NOT NULL,
    send_operation_id TEXT NOT NULL,
    recipient_role TEXT NOT NULL CHECK (recipient_role IN ('to', 'cc', 'bcc')),
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
    display_name TEXT,
    address_text TEXT NOT NULL CHECK (length(address_text) > 0),
    canonical_address TEXT COLLATE NOCASE NOT NULL CHECK (instr(canonical_address, '@') > 1),
    deduplication_key BLOB NOT NULL CHECK (length(deduplication_key) = 32),
    route_channel TEXT NOT NULL CHECK (route_channel IN ('internal_assigned', 'internal_unallocated', 'external')),
    message_delivery_id TEXT UNIQUE,
    delivery_status TEXT NOT NULL CHECK (
        delivery_status IN ('waiting', 'submitting', 'submitted', 'delayed', 'delivered', 'bounced', 'failed', 'unknown')
    ),
    status_version INTEGER NOT NULL DEFAULT 1 CHECK (status_version >= 1),
    status_updated_at INTEGER NOT NULL,
    failure_code TEXT,
    failure_detail TEXT,
    complained_at INTEGER,
    last_provider_reference TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (send_operation_id, deduplication_key),
    UNIQUE (send_operation_id, recipient_role, sequence_number),
    CHECK (updated_at >= created_at),
    CHECK (
        (route_channel IN ('internal_assigned', 'internal_unallocated') AND message_delivery_id IS NOT NULL AND delivery_status = 'delivered')
        OR (route_channel = 'external' AND message_delivery_id IS NULL)
    ),
    FOREIGN KEY (send_operation_id) REFERENCES send_operations (id) ON DELETE CASCADE,
    FOREIGN KEY (message_delivery_id) REFERENCES message_deliveries (id) ON DELETE RESTRICT
);

CREATE INDEX send_recipients_status_index
    ON send_recipients (delivery_status, status_updated_at, id);
CREATE INDEX send_recipients_operation_channel_index
    ON send_recipients (send_operation_id, route_channel, recipient_role, sequence_number);

CREATE TRIGGER validate_send_recipient_insert
BEFORE INSERT ON send_recipients
WHEN NOT EXISTS (
    SELECT 1
    FROM send_operations AS operation
    LEFT JOIN message_deliveries AS delivery
      ON delivery.id = NEW.message_delivery_id AND delivery.message_id = operation.message_id
    WHERE operation.id = NEW.send_operation_id
      AND (
          (NEW.route_channel = 'external' AND operation.external_recipient_count > 0 AND NEW.delivery_status = 'waiting' AND NEW.status_version = 1)
          OR (NEW.route_channel = 'internal_assigned' AND delivery.target_type = 'assigned' AND delivery.canonical_recipient_address = NEW.canonical_address COLLATE NOCASE)
          OR (NEW.route_channel = 'internal_unallocated' AND delivery.target_type = 'unallocated' AND delivery.canonical_recipient_address = NEW.canonical_address COLLATE NOCASE)
      )
)
BEGIN
    SELECT RAISE(ABORT, '逻辑收件人与发送操作或实际投递不匹配');
END;

CREATE TRIGGER validate_send_recipient_status_update
BEFORE UPDATE OF delivery_status, status_version, status_updated_at ON send_recipients
WHEN NEW.route_channel <> 'external'
  OR ((NEW.delivery_status <> OLD.delivery_status AND NEW.status_version <> OLD.status_version + 1)
      OR (NEW.delivery_status = OLD.delivery_status AND NEW.status_version <> OLD.status_version)
      OR NEW.status_updated_at < OLD.status_updated_at)
BEGIN
    SELECT RAISE(ABORT, '逻辑收件人状态版本无效');
END;

CREATE TRIGGER prevent_send_recipient_identity_change
BEFORE UPDATE OF send_operation_id, recipient_role, sequence_number, display_name, address_text,
    canonical_address, deduplication_key, route_channel, message_delivery_id, created_at
ON send_recipients
BEGIN
    SELECT RAISE(ABORT, '逻辑收件人身份不可修改');
END;

CREATE TABLE send_recipient_status_history (
    id TEXT PRIMARY KEY NOT NULL,
    send_recipient_id TEXT NOT NULL,
    previous_status TEXT,
    new_status TEXT NOT NULL,
    status_version INTEGER NOT NULL CHECK (status_version >= 1),
    source_type TEXT NOT NULL CHECK (
        source_type IN ('send_acceptance', 'provider_attempt', 'provider_event', 'permission_revoked', 'manual_reconciliation')
    ),
    source_reference TEXT NOT NULL CHECK (length(source_reference) > 0),
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (send_recipient_id, status_version),
    UNIQUE (send_recipient_id, source_type, source_reference),
    CHECK (new_status IN ('waiting', 'submitting', 'submitted', 'delayed', 'delivered', 'bounced', 'failed', 'unknown')),
    CHECK (previous_status IS NULL OR previous_status IN ('waiting', 'submitting', 'submitted', 'delayed', 'delivered', 'bounced', 'failed', 'unknown')),
    CHECK ((status_version = 1 AND previous_status IS NULL) OR (status_version > 1 AND previous_status IS NOT NULL)),
    FOREIGN KEY (send_recipient_id) REFERENCES send_recipients (id) ON DELETE CASCADE
);

CREATE TRIGGER validate_send_recipient_status_history_insert
BEFORE INSERT ON send_recipient_status_history
WHEN NOT EXISTS (
    SELECT 1 FROM send_recipients AS recipient
    WHERE recipient.id = NEW.send_recipient_id
      AND recipient.delivery_status = NEW.new_status
      AND recipient.status_version = NEW.status_version
)
BEGIN
    SELECT RAISE(ABORT, '逻辑收件人状态历史与当前状态不匹配');
END;

-- 每位站外收件人独立记录冻结路线和进度，允许一封信由不同 Provider 发送。
CREATE TABLE send_recipient_route_progress (
    send_recipient_id TEXT PRIMARY KEY NOT NULL,
    route_snapshot_id TEXT NOT NULL,
    next_priority_number INTEGER NOT NULL DEFAULT 0 CHECK (next_priority_number >= 0),
    selected_route_snapshot_entry_id TEXT,
    progress_status TEXT NOT NULL CHECK (
        progress_status IN ('ready', 'submitting', 'not_accepted', 'accepted', 'unknown', 'finished')
    ),
    last_attempt_id TEXT,
    last_switch_reason TEXT CHECK (
        last_switch_reason IS NULL OR last_switch_reason IN ('service_unavailable', 'size_incompatible', 'temporary_rejection', 'configuration_disabled')
    ),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    FOREIGN KEY (send_recipient_id) REFERENCES send_recipients (id) ON DELETE CASCADE,
    FOREIGN KEY (route_snapshot_id) REFERENCES outbound_route_snapshots (id) ON DELETE RESTRICT,
    FOREIGN KEY (selected_route_snapshot_entry_id) REFERENCES outbound_route_snapshot_entries (id) ON DELETE RESTRICT
);

CREATE INDEX send_recipient_route_progress_work_index
    ON send_recipient_route_progress (progress_status, updated_at, send_recipient_id);

CREATE TRIGGER validate_send_recipient_route_progress_insert
BEFORE INSERT ON send_recipient_route_progress
WHEN NOT EXISTS (
    SELECT 1
    FROM send_recipients AS recipient
    JOIN send_operations AS operation ON operation.id = recipient.send_operation_id
    JOIN outbound_route_snapshots AS snapshot
      ON snapshot.id = NEW.route_snapshot_id
     AND snapshot.id = operation.outbound_route_snapshot_id
     AND snapshot.execution_kind = 'send'
     AND snapshot.execution_reference = operation.id
    WHERE recipient.id = NEW.send_recipient_id
      AND recipient.route_channel = 'external'
)
BEGIN
    SELECT RAISE(ABORT, '只有站外收件人可以建立匹配发送操作的路线进度');
END;

CREATE TRIGGER validate_send_recipient_route_progress_update
BEFORE UPDATE OF next_priority_number, selected_route_snapshot_entry_id, progress_status, last_switch_reason
ON send_recipient_route_progress
WHEN NEW.next_priority_number < OLD.next_priority_number
  OR (OLD.progress_status = 'unknown' AND NEW.progress_status <> 'unknown')
  OR (NEW.selected_route_snapshot_entry_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM outbound_route_snapshot_entries AS entry
      WHERE entry.id = NEW.selected_route_snapshot_entry_id
        AND entry.route_snapshot_id = OLD.route_snapshot_id
        AND entry.priority_number = NEW.next_priority_number
  ))
BEGIN
    SELECT RAISE(ABORT, '收件人路线进度不能倒退、越过冻结路线或从结果未知自动恢复');
END;

CREATE TABLE outbound_submission_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    send_operation_id TEXT NOT NULL,
    route_snapshot_entry_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    attempt_status TEXT NOT NULL CHECK (
        attempt_status IN ('prepared', 'submitting', 'accepted', 'not_accepted', 'unknown')
    ),
    payload_sha256 BLOB NOT NULL CHECK (length(payload_sha256) = 32),
    payload_size_bytes INTEGER NOT NULL CHECK (payload_size_bytes >= 0),
    idempotency_key_digest BLOB CHECK (idempotency_key_digest IS NULL OR length(idempotency_key_digest) = 32),
    provider_submission_id TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    error_code TEXT,
    error_summary TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (send_operation_id, attempt_number),
    CHECK (updated_at >= created_at),
    CHECK (
        (attempt_status = 'prepared' AND started_at IS NULL AND completed_at IS NULL)
        OR (attempt_status = 'submitting' AND started_at IS NOT NULL AND completed_at IS NULL)
        OR (attempt_status IN ('accepted', 'not_accepted', 'unknown') AND started_at IS NOT NULL AND completed_at IS NOT NULL AND completed_at >= started_at)
    ),
    FOREIGN KEY (send_operation_id) REFERENCES send_operations (id) ON DELETE CASCADE,
    FOREIGN KEY (route_snapshot_entry_id) REFERENCES outbound_route_snapshot_entries (id) ON DELETE RESTRICT
);

CREATE INDEX outbound_submission_attempts_work_index
    ON outbound_submission_attempts (attempt_status, created_at, id);

CREATE TRIGGER validate_outbound_submission_attempt_insert
BEFORE INSERT ON outbound_submission_attempts
WHEN NOT EXISTS (
    SELECT 1
    FROM send_operations AS operation
    JOIN outbound_route_snapshot_entries AS entry
      ON entry.id = NEW.route_snapshot_entry_id
     AND entry.route_snapshot_id = operation.outbound_route_snapshot_id
    WHERE operation.id = NEW.send_operation_id
      AND operation.payload_sha256 = NEW.payload_sha256
      AND operation.payload_size_bytes = NEW.payload_size_bytes
      AND NEW.payload_size_bytes <= entry.effective_size_limit_bytes
)
BEGIN
    SELECT RAISE(ABORT, '外部提交尝试与发送路线快照或负载不匹配');
END;

CREATE TRIGGER prevent_outbound_submission_attempt_identity_change
BEFORE UPDATE OF send_operation_id, route_snapshot_entry_id, attempt_number, payload_sha256,
    payload_size_bytes, idempotency_key_digest, created_at
ON outbound_submission_attempts
BEGIN
    SELECT RAISE(ABORT, '外部提交尝试身份不可修改');
END;

CREATE TRIGGER validate_outbound_submission_attempt_transition
BEFORE UPDATE OF attempt_status ON outbound_submission_attempts
WHEN NEW.attempt_status <> OLD.attempt_status
  AND NOT (
      (OLD.attempt_status = 'prepared' AND NEW.attempt_status = 'submitting')
      OR (OLD.attempt_status = 'submitting' AND NEW.attempt_status IN ('accepted', 'not_accepted', 'unknown'))
  )
BEGIN
    SELECT RAISE(ABORT, '外部提交尝试状态不能倒退或跳转');
END;

CREATE TABLE outbound_submission_attempt_recipients (
    outbound_submission_attempt_id TEXT NOT NULL,
    send_recipient_id TEXT NOT NULL,
    selection_kind TEXT NOT NULL CHECK (
        selection_kind IN ('initial', 'safe_retry', 'idempotent_retry', 'fallback')
    ),
    fallback_reason TEXT CHECK (
        fallback_reason IS NULL OR fallback_reason IN ('service_unavailable', 'size_incompatible', 'temporary_rejection', 'configuration_disabled')
    ),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (outbound_submission_attempt_id, send_recipient_id),
    CHECK ((selection_kind = 'fallback' AND fallback_reason IS NOT NULL) OR (selection_kind <> 'fallback' AND fallback_reason IS NULL)),
    FOREIGN KEY (outbound_submission_attempt_id) REFERENCES outbound_submission_attempts (id) ON DELETE CASCADE,
    FOREIGN KEY (send_recipient_id) REFERENCES send_recipients (id) ON DELETE CASCADE
);

CREATE INDEX outbound_submission_attempt_recipients_recipient_index
    ON outbound_submission_attempt_recipients (send_recipient_id, outbound_submission_attempt_id);

CREATE TRIGGER validate_outbound_submission_attempt_recipient_insert
BEFORE INSERT ON outbound_submission_attempt_recipients
WHEN NOT EXISTS (
    SELECT 1
    FROM outbound_submission_attempts AS attempt
    JOIN send_recipients AS recipient
      ON recipient.id = NEW.send_recipient_id
     AND recipient.send_operation_id = attempt.send_operation_id
     AND recipient.route_channel = 'external'
     AND recipient.delivery_status NOT IN ('delivered', 'bounced', 'failed', 'unknown')
    JOIN send_recipient_route_progress AS progress
      ON progress.send_recipient_id = recipient.id
    JOIN outbound_route_snapshot_entries AS entry
      ON entry.id = attempt.route_snapshot_entry_id
     AND entry.route_snapshot_id = progress.route_snapshot_id
     AND entry.priority_number = progress.next_priority_number
    WHERE attempt.id = NEW.outbound_submission_attempt_id
)
BEGIN
    SELECT RAISE(ABORT, '外部提交尝试不能包含该收件人或跳过路线顺序');
END;

CREATE TRIGGER prevent_fallback_after_unknown_result
BEFORE INSERT ON outbound_submission_attempt_recipients
WHEN NEW.selection_kind = 'fallback'
  AND EXISTS (
      SELECT 1
      FROM outbound_submission_attempt_recipients AS previous_link
      JOIN outbound_submission_attempts AS previous_attempt
        ON previous_attempt.id = previous_link.outbound_submission_attempt_id
      WHERE previous_link.send_recipient_id = NEW.send_recipient_id
        AND previous_attempt.attempt_status = 'unknown'
  )
BEGIN
    SELECT RAISE(ABORT, '结果未知时不得自动切换备用服务');
END;

CREATE TRIGGER prevent_outbound_submission_attempt_recipient_change
BEFORE UPDATE ON outbound_submission_attempt_recipients
BEGIN
    SELECT RAISE(ABORT, '外部提交尝试收件人关系不可修改');
END;

CREATE TABLE outbound_provider_events (
    id TEXT PRIMARY KEY NOT NULL,
    provider_type TEXT NOT NULL CHECK (provider_type IN ('resend', 'smtp2go')),
    provider_event_id TEXT NOT NULL CHECK (length(provider_event_id) > 0),
    normalized_event_type TEXT NOT NULL CHECK (
        normalized_event_type IN ('submitted', 'delayed', 'delivered', 'bounced', 'failed', 'complained', 'opened', 'clicked', 'other')
    ),
    occurred_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    verified_at INTEGER NOT NULL,
    raw_sha256 BLOB NOT NULL CHECK (length(raw_sha256) = 32),
    diagnostic_code TEXT,
    diagnostic_summary TEXT,
    outbound_submission_attempt_id TEXT,
    send_recipient_id TEXT,
    match_status TEXT NOT NULL CHECK (match_status IN ('pending', 'matched', 'ignored')),
    processing_result TEXT NOT NULL CHECK (processing_result IN ('pending', 'applied', 'no_change', 'ignored', 'rejected')),
    processed_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (provider_type, provider_event_id),
    CHECK (verified_at >= received_at),
    CHECK (
        (match_status = 'pending' AND processing_result = 'pending' AND processed_at IS NULL)
        OR (match_status = 'matched' AND processing_result IN ('applied', 'no_change', 'rejected') AND processed_at IS NOT NULL)
        OR (match_status = 'ignored' AND processing_result = 'ignored' AND processed_at IS NOT NULL)
    ),
    FOREIGN KEY (outbound_submission_attempt_id) REFERENCES outbound_submission_attempts (id) ON DELETE SET NULL,
    FOREIGN KEY (send_recipient_id) REFERENCES send_recipients (id) ON DELETE SET NULL
);

CREATE INDEX outbound_provider_events_pending_index
    ON outbound_provider_events (match_status, received_at, id)
    WHERE match_status = 'pending';

CREATE TRIGGER validate_outbound_provider_event_links
BEFORE INSERT ON outbound_provider_events
WHEN NEW.match_status = 'matched'
  AND NOT EXISTS (
      SELECT 1
      FROM send_recipients AS recipient
      JOIN send_recipient_route_progress AS progress ON progress.send_recipient_id = recipient.id
      LEFT JOIN outbound_submission_attempts AS attempt
        ON attempt.id = NEW.outbound_submission_attempt_id
       AND attempt.send_operation_id = recipient.send_operation_id
      LEFT JOIN outbound_route_snapshot_entries AS entry ON entry.id = attempt.route_snapshot_entry_id
      WHERE recipient.id = NEW.send_recipient_id
        AND recipient.route_channel = 'external'
        AND (NEW.outbound_submission_attempt_id IS NULL OR entry.provider_type = NEW.provider_type)
  )
BEGIN
    SELECT RAISE(ABORT, '供应商事件与发送尝试或收件人不匹配');
END;

CREATE TRIGGER prevent_outbound_provider_event_identity_change
BEFORE UPDATE OF provider_type, provider_event_id, normalized_event_type, occurred_at, received_at,
    verified_at, raw_sha256, diagnostic_code, diagnostic_summary, created_at
ON outbound_provider_events
BEGIN
    SELECT RAISE(ABORT, '已验证供应商事件事实不可修改');
END;

-- 用户通知：操作只引用邮件投递，不在 D1 复制正文或附件。
CREATE TABLE notification_subscriptions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    channel_type TEXT NOT NULL CHECK (channel_type IN ('ntfy', 'gotify', 'wxpusher', 'telegram', 'bark')),
    public_options_json TEXT NOT NULL CHECK (json_valid(public_options_json)),
    subscription_status TEXT NOT NULL CHECK (subscription_status IN ('active', 'paused', 'deleted')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    CHECK (updated_at >= created_at),
    CHECK ((subscription_status = 'deleted' AND deleted_at IS NOT NULL) OR (subscription_status <> 'deleted' AND deleted_at IS NULL)),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX notification_subscriptions_user_index
    ON notification_subscriptions (user_id, subscription_status, id);

CREATE TABLE notification_subscription_scopes (
    id TEXT PRIMARY KEY NOT NULL,
    notification_subscription_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('all_personal', 'personal_address', 'organization_address')),
    email_address_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (notification_subscription_id, scope_kind, email_address_id),
    CHECK ((scope_kind = 'all_personal' AND email_address_id IS NULL) OR (scope_kind <> 'all_personal' AND email_address_id IS NOT NULL)),
    FOREIGN KEY (notification_subscription_id) REFERENCES notification_subscriptions (id) ON DELETE CASCADE,
    FOREIGN KEY (email_address_id) REFERENCES email_addresses (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX notification_subscription_all_personal_unique
    ON notification_subscription_scopes (notification_subscription_id)
    WHERE scope_kind = 'all_personal';

CREATE TRIGGER validate_notification_subscription_scope_insert
BEFORE INSERT ON notification_subscription_scopes
WHEN NEW.scope_kind <> 'all_personal'
  AND NOT EXISTS (
      SELECT 1
      FROM notification_subscriptions AS subscription
      JOIN address_bindings AS binding
        ON binding.address_id = NEW.email_address_id
       AND binding.ended_at IS NULL
      LEFT JOIN organization_memberships AS membership
        ON membership.organization_id = binding.organization_id
       AND membership.user_id = subscription.user_id
       AND membership.left_at IS NULL
      WHERE subscription.id = NEW.notification_subscription_id
        AND ((NEW.scope_kind = 'personal_address' AND binding.owner_type = 'user' AND binding.user_id = subscription.user_id)
          OR (NEW.scope_kind = 'organization_address' AND binding.owner_type = 'organization' AND membership.id IS NOT NULL))
  )
BEGIN
    SELECT RAISE(ABORT, '通知范围不是用户当前可查看的邮箱地址');
END;

CREATE TRIGGER prevent_notification_subscription_scope_change
BEFORE UPDATE ON notification_subscription_scopes
BEGIN
    SELECT RAISE(ABORT, '通知范围不可修改，请删除后重新建立');
END;

CREATE TABLE notification_subscription_secrets (
    notification_subscription_id TEXT PRIMARY KEY NOT NULL,
    credential_ciphertext BLOB NOT NULL CHECK (length(credential_ciphertext) > 0),
    credential_nonce BLOB NOT NULL CHECK (length(credential_nonce) = 12),
    credential_algorithm TEXT NOT NULL CHECK (credential_algorithm = 'AES-GCM-256'),
    credential_key_version INTEGER NOT NULL CHECK (credential_key_version >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    FOREIGN KEY (notification_subscription_id) REFERENCES notification_subscriptions (id) ON DELETE CASCADE
);

CREATE TRIGGER prevent_notification_subscription_secret_change
BEFORE UPDATE OF credential_ciphertext, credential_nonce, credential_algorithm, credential_key_version, created_at
ON notification_subscription_secrets
BEGIN
    SELECT RAISE(ABORT, '通知端点凭据不可原地修改，请替换订阅密钥版本');
END;

CREATE TABLE notification_operations (
    id TEXT PRIMARY KEY NOT NULL,
    notification_subscription_id TEXT NOT NULL,
    message_delivery_id TEXT NOT NULL,
    payload_object_set_version INTEGER NOT NULL CHECK (payload_object_set_version >= 1),
    payload_size_bytes INTEGER NOT NULL CHECK (payload_size_bytes >= 0),
    payload_sha256 BLOB NOT NULL CHECK (length(payload_sha256) = 32),
    operation_status TEXT NOT NULL CHECK (operation_status IN ('pending', 'submitting', 'submitted', 'failed', 'cancelled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    UNIQUE (notification_subscription_id, message_delivery_id),
    CHECK (updated_at >= created_at),
    CHECK ((operation_status IN ('submitted', 'failed', 'cancelled') AND completed_at IS NOT NULL) OR (operation_status IN ('pending', 'submitting') AND completed_at IS NULL)),
    FOREIGN KEY (notification_subscription_id) REFERENCES notification_subscriptions (id) ON DELETE RESTRICT,
    FOREIGN KEY (message_delivery_id) REFERENCES message_deliveries (id) ON DELETE RESTRICT
);

CREATE INDEX notification_operations_work_index
    ON notification_operations (operation_status, created_at, id);

CREATE TRIGGER validate_notification_operation_insert
BEFORE INSERT ON notification_operations
WHEN NOT EXISTS (
    SELECT 1
    FROM notification_subscriptions AS subscription
    JOIN users AS user
      ON user.id = subscription.user_id
     AND user.status = 'active'
    JOIN message_deliveries AS delivery ON delivery.id = NEW.message_delivery_id
    JOIN message_integrity_states AS integrity
      ON integrity.message_id = delivery.message_id
     AND integrity.integrity_status = 'ready'
    JOIN address_bindings AS binding
      ON binding.id = delivery.address_binding_id
     AND binding.ended_at IS NULL
    LEFT JOIN organization_memberships AS membership
      ON membership.organization_id = binding.organization_id
     AND membership.user_id = subscription.user_id
     AND membership.left_at IS NULL
    WHERE subscription.id = NEW.notification_subscription_id
      AND subscription.subscription_status = 'active'
      AND EXISTS (
          SELECT 1
          FROM notification_subscription_scopes AS scope
          WHERE scope.notification_subscription_id = subscription.id
            AND (
                (scope.scope_kind = 'all_personal'
                    AND binding.owner_type = 'user'
                    AND binding.user_id = subscription.user_id)
                OR (scope.scope_kind = 'personal_address'
                    AND binding.owner_type = 'user'
                    AND binding.user_id = subscription.user_id
                    AND scope.email_address_id = binding.address_id)
                OR (scope.scope_kind = 'organization_address'
                    AND binding.owner_type = 'organization'
                    AND membership.id IS NOT NULL
                    AND scope.email_address_id = binding.address_id)
            )
      )
)
BEGIN
    SELECT RAISE(ABORT, '通知操作必须在邮件完整且订阅范围仍有权限时建立');
END;

CREATE TABLE notification_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    notification_operation_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    attempt_status TEXT NOT NULL CHECK (attempt_status IN ('prepared', 'submitting', 'submitted', 'failed', 'unknown')),
    started_at INTEGER,
    completed_at INTEGER,
    error_code TEXT,
    error_summary TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (notification_operation_id, attempt_number),
    CHECK ((attempt_status = 'prepared' AND started_at IS NULL AND completed_at IS NULL)
      OR (attempt_status = 'submitting' AND started_at IS NOT NULL AND completed_at IS NULL)
      OR (attempt_status IN ('submitted', 'failed', 'unknown') AND started_at IS NOT NULL AND completed_at IS NOT NULL)),
    FOREIGN KEY (notification_operation_id) REFERENCES notification_operations (id) ON DELETE CASCADE
);

-- 外部邮箱验证：验证码仅保存摘要，且不可从 URL 或普通日志重建。
CREATE TABLE external_email_targets (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    display_email_address TEXT NOT NULL CHECK (length(display_email_address) > 3),
    canonical_email_address TEXT COLLATE NOCASE NOT NULL CHECK (instr(canonical_email_address, '@') > 1),
    target_status TEXT NOT NULL CHECK (target_status IN ('pending', 'verified', 'expired', 'disabled', 'deleted')),
    verified_at INTEGER,
    disabled_at INTEGER,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK ((target_status = 'verified' AND verified_at IS NOT NULL) OR target_status <> 'verified'),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX external_email_targets_current_unique
    ON external_email_targets (user_id, canonical_email_address)
    WHERE target_status <> 'deleted';

CREATE INDEX external_email_targets_user_index
    ON external_email_targets (user_id, target_status, id);

CREATE TRIGGER prevent_external_email_target_identity_change
BEFORE UPDATE OF user_id, canonical_email_address, created_at
ON external_email_targets
BEGIN
    SELECT RAISE(ABORT, '外部邮箱目标身份不可修改');
END;

CREATE TABLE external_email_verifications (
    id TEXT PRIMARY KEY NOT NULL,
    external_email_target_id TEXT NOT NULL,
    verification_code_hash BLOB NOT NULL CHECK (length(verification_code_hash) = 32),
    verification_code_salt BLOB NOT NULL CHECK (length(verification_code_salt) >= 16),
    expires_at INTEGER NOT NULL,
    max_failure_count INTEGER NOT NULL CHECK (max_failure_count >= 1),
    failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    verification_status TEXT NOT NULL CHECK (verification_status IN ('pending_delivery', 'pending_input', 'verified', 'expired', 'failed', 'cancelled')),
    outbound_route_snapshot_id TEXT,
    delivered_at INTEGER,
    verified_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (expires_at > created_at),
    CHECK (failure_count <= max_failure_count),
    CHECK ((verification_status = 'verified' AND verified_at IS NOT NULL) OR verification_status <> 'verified'),
    FOREIGN KEY (external_email_target_id) REFERENCES external_email_targets (id) ON DELETE RESTRICT,
    FOREIGN KEY (outbound_route_snapshot_id) REFERENCES outbound_route_snapshots (id) ON DELETE RESTRICT
);

CREATE INDEX external_email_verifications_target_index
    ON external_email_verifications (external_email_target_id, verification_status, created_at DESC);

CREATE TRIGGER validate_external_email_verification_snapshot_insert
BEFORE INSERT ON external_email_verifications
WHEN NEW.outbound_route_snapshot_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM outbound_route_snapshots AS snapshot
      WHERE snapshot.id = NEW.outbound_route_snapshot_id
        AND snapshot.execution_kind = 'external_email_verification'
        AND snapshot.execution_reference = NEW.id
  )
BEGIN
    SELECT RAISE(ABORT, '外部邮箱验证必须引用自己的冻结发信路线');
END;

CREATE TRIGGER prevent_external_email_verification_secret_change
BEFORE UPDATE OF external_email_target_id, verification_code_hash, verification_code_salt, expires_at,
    max_failure_count, outbound_route_snapshot_id, created_at
ON external_email_verifications
BEGIN
    SELECT RAISE(ABORT, '外部邮箱验证码及冻结路线不可修改');
END;

CREATE TRIGGER validate_external_email_verification_transition
BEFORE UPDATE OF verification_status ON external_email_verifications
WHEN NEW.verification_status <> OLD.verification_status
  AND NOT (
      (OLD.verification_status = 'pending_delivery' AND NEW.verification_status IN ('pending_input', 'failed', 'cancelled'))
      OR (OLD.verification_status = 'pending_input' AND NEW.verification_status IN ('verified', 'expired', 'failed', 'cancelled'))
  )
BEGIN
    SELECT RAISE(ABORT, '外部邮箱验证状态不能倒退或重复使用');
END;

-- 自动转发仅适用于个人地址。它是独立外部操作，不产生用户的“已发送”邮件。
CREATE TABLE mail_forwarding_rules (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    external_email_target_id TEXT NOT NULL,
    rule_version INTEGER NOT NULL CHECK (rule_version >= 1),
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('all_personal', 'selected_personal_addresses')),
    rule_status TEXT NOT NULL CHECK (rule_status IN ('active', 'paused', 'deleted')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    UNIQUE (id, rule_version),
    CHECK (updated_at >= created_at),
    CHECK ((rule_status = 'deleted' AND deleted_at IS NOT NULL) OR (rule_status <> 'deleted' AND deleted_at IS NULL)),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (external_email_target_id) REFERENCES external_email_targets (id) ON DELETE RESTRICT
);

CREATE INDEX mail_forwarding_rules_user_index
    ON mail_forwarding_rules (user_id, rule_status, id);

CREATE TRIGGER validate_mail_forwarding_rule_insert
BEFORE INSERT ON mail_forwarding_rules
WHEN NOT EXISTS (
    SELECT 1 FROM external_email_targets AS target
    WHERE target.id = NEW.external_email_target_id
      AND target.user_id = NEW.user_id
      AND target.target_status = 'verified'
)
BEGIN
    SELECT RAISE(ABORT, '转发规则只能使用自己的已验证外部邮箱');
END;

CREATE TRIGGER prevent_mail_forwarding_rule_identity_change
BEFORE UPDATE OF user_id, external_email_target_id, rule_version, scope_kind, created_at
ON mail_forwarding_rules
BEGIN
    SELECT RAISE(ABORT, '转发规则版本不可原地修改');
END;

CREATE TABLE mail_forwarding_rule_addresses (
    mail_forwarding_rule_id TEXT NOT NULL,
    email_address_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (mail_forwarding_rule_id, email_address_id),
    FOREIGN KEY (mail_forwarding_rule_id) REFERENCES mail_forwarding_rules (id) ON DELETE CASCADE,
    FOREIGN KEY (email_address_id) REFERENCES email_addresses (id) ON DELETE RESTRICT
);

CREATE TRIGGER validate_mail_forwarding_rule_address_insert
BEFORE INSERT ON mail_forwarding_rule_addresses
WHEN NOT EXISTS (
    SELECT 1
    FROM mail_forwarding_rules AS rule
    JOIN address_bindings AS binding
      ON binding.address_id = NEW.email_address_id
     AND binding.owner_type = 'user'
     AND binding.user_id = rule.user_id
     AND binding.ended_at IS NULL
    WHERE rule.id = NEW.mail_forwarding_rule_id
      AND rule.scope_kind = 'selected_personal_addresses'
)
BEGIN
    SELECT RAISE(ABORT, '转发规则只能指定当前用户的个人地址');
END;

CREATE TRIGGER prevent_mail_forwarding_rule_address_change
BEFORE UPDATE ON mail_forwarding_rule_addresses
BEGIN
    SELECT RAISE(ABORT, '转发规则地址范围不可修改');
END;

CREATE TABLE mail_forward_operations (
    id TEXT PRIMARY KEY NOT NULL,
    source_message_id TEXT NOT NULL,
    message_delivery_id TEXT NOT NULL,
    mail_forwarding_rule_id TEXT NOT NULL,
    rule_version INTEGER NOT NULL CHECK (rule_version >= 1),
    external_email_target_id TEXT NOT NULL,
    target_canonical_email_address TEXT COLLATE NOCASE NOT NULL CHECK (instr(target_canonical_email_address, '@') > 1),
    payload_sha256 BLOB NOT NULL CHECK (length(payload_sha256) = 32),
    payload_size_bytes INTEGER NOT NULL CHECK (payload_size_bytes >= 0),
    forwarding_hop_count INTEGER NOT NULL CHECK (forwarding_hop_count >= 0 AND forwarding_hop_count <= 5),
    source_marked_by_simlettra INTEGER NOT NULL DEFAULT 0 CHECK (source_marked_by_simlettra IN (0, 1)),
    outbound_route_snapshot_id TEXT NOT NULL UNIQUE,
    operation_status TEXT NOT NULL CHECK (operation_status IN ('pending', 'submitting', 'submitted', 'failed', 'cancelled', 'rejected_loop')),
    rejection_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    UNIQUE (message_delivery_id, mail_forwarding_rule_id, rule_version, external_email_target_id),
    CHECK (updated_at >= created_at),
    CHECK ((operation_status IN ('submitted', 'failed', 'cancelled', 'rejected_loop') AND completed_at IS NOT NULL) OR (operation_status IN ('pending', 'submitting') AND completed_at IS NULL)),
    CHECK ((operation_status = 'rejected_loop' AND rejection_code IS NOT NULL) OR operation_status <> 'rejected_loop'),
    CHECK ((source_marked_by_simlettra = 0 AND forwarding_hop_count < 5) OR operation_status = 'rejected_loop'),
    FOREIGN KEY (source_message_id) REFERENCES messages (id) ON DELETE RESTRICT,
    FOREIGN KEY (message_delivery_id) REFERENCES message_deliveries (id) ON DELETE RESTRICT,
    FOREIGN KEY (mail_forwarding_rule_id, rule_version) REFERENCES mail_forwarding_rules (id, rule_version) ON DELETE RESTRICT,
    FOREIGN KEY (external_email_target_id) REFERENCES external_email_targets (id) ON DELETE RESTRICT,
    FOREIGN KEY (outbound_route_snapshot_id) REFERENCES outbound_route_snapshots (id) ON DELETE RESTRICT
);

CREATE INDEX mail_forward_operations_work_index
    ON mail_forward_operations (operation_status, created_at, id);

CREATE TRIGGER validate_mail_forward_operation_insert
BEFORE INSERT ON mail_forward_operations
WHEN NOT EXISTS (
    SELECT 1
    FROM message_deliveries AS delivery
    JOIN mail_forwarding_rules AS rule
      ON rule.id = NEW.mail_forwarding_rule_id
     AND rule.rule_version = NEW.rule_version
     AND rule.rule_status = 'active'
    JOIN external_email_targets AS target
      ON target.id = NEW.external_email_target_id
     AND target.id = rule.external_email_target_id
     AND target.user_id = rule.user_id
     AND target.target_status = 'verified'
     AND target.canonical_email_address = NEW.target_canonical_email_address COLLATE NOCASE
    JOIN outbound_route_snapshots AS snapshot
      ON snapshot.id = NEW.outbound_route_snapshot_id
     AND snapshot.execution_kind = 'forward'
     AND snapshot.execution_reference = NEW.id
     AND snapshot.payload_sha256 = NEW.payload_sha256
     AND snapshot.payload_size_bytes = NEW.payload_size_bytes
    WHERE delivery.id = NEW.message_delivery_id
      AND delivery.message_id = NEW.source_message_id
)
BEGIN
    SELECT RAISE(ABORT, '转发操作与原始投递、规则、目标或冻结路线不匹配');
END;

CREATE TRIGGER validate_mail_forward_operation_personal_scope
BEFORE INSERT ON mail_forward_operations
WHEN NOT EXISTS (
    SELECT 1
    FROM mail_forwarding_rules AS rule
    JOIN message_deliveries AS delivery ON delivery.id = NEW.message_delivery_id
    JOIN address_bindings AS binding
      ON binding.id = delivery.address_binding_id
     AND binding.owner_type = 'user'
     AND binding.user_id = rule.user_id
    WHERE rule.id = NEW.mail_forwarding_rule_id
      AND (
          rule.scope_kind = 'all_personal'
          OR EXISTS (
              SELECT 1 FROM mail_forwarding_rule_addresses AS selected
              WHERE selected.mail_forwarding_rule_id = rule.id
                AND selected.email_address_id = binding.address_id
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, '自动转发只允许匹配用户自己的个人地址');
END;

CREATE TRIGGER reject_mail_forward_system_domain_loop
BEFORE INSERT ON mail_forward_operations
WHEN NEW.operation_status <> 'rejected_loop'
  AND EXISTS (
      SELECT 1
      FROM mail_domains AS domain
      WHERE domain.canonical_name = substr(
          NEW.target_canonical_email_address,
          instr(NEW.target_canonical_email_address, '@') + 1
      ) COLLATE NOCASE
  )
BEGIN
    SELECT RAISE(ABORT, '转发目标不能是本系统管理域名');
END;

CREATE TRIGGER prevent_mail_forward_operation_identity_change
BEFORE UPDATE OF source_message_id, message_delivery_id, mail_forwarding_rule_id, rule_version,
    external_email_target_id, target_canonical_email_address, payload_sha256, payload_size_bytes,
    forwarding_hop_count, source_marked_by_simlettra, outbound_route_snapshot_id, created_at
ON mail_forward_operations
BEGIN
    SELECT RAISE(ABORT, '转发操作的冻结身份不可修改');
END;

CREATE TABLE mail_forward_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    mail_forward_operation_id TEXT NOT NULL,
    route_snapshot_entry_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    selection_kind TEXT NOT NULL CHECK (selection_kind IN ('initial', 'safe_retry', 'fallback')),
    fallback_reason TEXT CHECK (fallback_reason IS NULL OR fallback_reason IN ('service_unavailable', 'size_incompatible', 'temporary_rejection', 'configuration_disabled')),
    attempt_status TEXT NOT NULL CHECK (attempt_status IN ('prepared', 'submitting', 'accepted', 'not_accepted', 'unknown')),
    started_at INTEGER,
    completed_at INTEGER,
    error_code TEXT,
    error_summary TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (mail_forward_operation_id, attempt_number),
    CHECK ((selection_kind = 'fallback' AND fallback_reason IS NOT NULL) OR (selection_kind <> 'fallback' AND fallback_reason IS NULL)),
    CHECK ((attempt_status = 'prepared' AND started_at IS NULL AND completed_at IS NULL)
      OR (attempt_status = 'submitting' AND started_at IS NOT NULL AND completed_at IS NULL)
      OR (attempt_status IN ('accepted', 'not_accepted', 'unknown') AND started_at IS NOT NULL AND completed_at IS NOT NULL)),
    FOREIGN KEY (mail_forward_operation_id) REFERENCES mail_forward_operations (id) ON DELETE CASCADE,
    FOREIGN KEY (route_snapshot_entry_id) REFERENCES outbound_route_snapshot_entries (id) ON DELETE RESTRICT
);

CREATE TRIGGER validate_mail_forward_attempt_insert
BEFORE INSERT ON mail_forward_attempts
WHEN NOT EXISTS (
    SELECT 1
    FROM mail_forward_operations AS operation
    JOIN outbound_route_snapshot_entries AS entry
      ON entry.id = NEW.route_snapshot_entry_id
     AND entry.route_snapshot_id = operation.outbound_route_snapshot_id
    WHERE operation.id = NEW.mail_forward_operation_id
      AND entry.effective_size_limit_bytes >= operation.payload_size_bytes
)
BEGIN
    SELECT RAISE(ABORT, '转发尝试与冻结路线或大小限制不匹配');
END;

CREATE TRIGGER prevent_mail_forward_fallback_after_unknown
BEFORE INSERT ON mail_forward_attempts
WHEN NEW.selection_kind = 'fallback'
  AND EXISTS (
      SELECT 1 FROM mail_forward_attempts AS previous
      WHERE previous.mail_forward_operation_id = NEW.mail_forward_operation_id
        AND previous.attempt_status = 'unknown'
  )
BEGIN
    SELECT RAISE(ABORT, '转发结果未知时不得自动切换备用服务');
END;

CREATE TRIGGER prevent_mail_forward_attempt_identity_change
BEFORE UPDATE OF mail_forward_operation_id, route_snapshot_entry_id, attempt_number, selection_kind,
    fallback_reason, created_at
ON mail_forward_attempts
BEGIN
    SELECT RAISE(ABORT, '转发尝试身份不可修改');
END;
