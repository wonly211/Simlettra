-- 澄笺 | Simlettra 正式发信、逐收件人状态与域外路线

PRAGMA foreign_keys = ON;

-- 收信邮件需要原始 MIME；系统生成邮件需要最终 MIME。两类邮件都必须有正文和完整附件。
DROP TRIGGER validate_message_ready_insert;

CREATE TRIGGER validate_message_ready_insert
BEFORE INSERT ON message_integrity_states
WHEN NEW.integrity_status = 'ready'
AND (
    NEW.source_completeness NOT IN ('raw_mime', 'final_mime')
    OR (
        NEW.source_completeness = 'raw_mime'
        AND NOT EXISTS (
            SELECT 1 FROM object_registry
            WHERE message_id = NEW.message_id AND object_role = 'raw_mime'
              AND is_current = 1 AND object_status = 'active'
        )
    )
    OR (
        NEW.source_completeness = 'final_mime'
        AND NOT EXISTS (
            SELECT 1 FROM object_registry
            WHERE message_id = NEW.message_id AND object_role = 'final_mime'
              AND is_current = 1 AND object_status = 'active'
        )
    )
    OR NOT EXISTS (
        SELECT 1 FROM object_registry
        WHERE message_id = NEW.message_id AND object_role IN ('plain_body', 'html_body')
          AND is_current = 1 AND object_status = 'active'
    )
    OR EXISTS (
        SELECT 1 FROM object_registry
        WHERE message_id = NEW.message_id AND required_for_visibility = 1
          AND (is_current <> 1 OR object_status <> 'active')
    )
    OR (
        SELECT attachment_count FROM messages WHERE id = NEW.message_id
    ) <> (
        SELECT COUNT(*) FROM object_registry
        WHERE message_id = NEW.message_id AND object_role = 'attachment'
          AND is_current = 1 AND object_status = 'active'
    )
)
BEGIN
    SELECT RAISE(ABORT, '邮件必要对象尚未完整，不能进入就绪状态');
END;

-- 管理员维护的版本化域外发信服务。凭据使用部署配置中的独立主密钥加密。
CREATE TABLE outbound_provider_configs (
    id TEXT PRIMARY KEY NOT NULL,
    configuration_key TEXT NOT NULL CHECK (length(configuration_key) BETWEEN 1 AND 80),
    configuration_version INTEGER NOT NULL CHECK (configuration_version >= 1),
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
    provider_type TEXT NOT NULL CHECK (provider_type IN ('resend', 'smtp2go')),
    public_options_json TEXT NOT NULL CHECK (json_valid(public_options_json)),
    credential_ciphertext BLOB NOT NULL CHECK (length(credential_ciphertext) > 0),
    credential_nonce BLOB NOT NULL CHECK (length(credential_nonce) = 12),
    credential_algorithm TEXT NOT NULL CHECK (credential_algorithm = 'AES-GCM-256'),
    credential_key_version INTEGER NOT NULL CHECK (credential_key_version >= 1),
    credential_updated_at INTEGER NOT NULL,
    configuration_status TEXT NOT NULL CHECK (
        configuration_status IN ('active', 'disabled', 'retired')
    ),
    last_tested_at INTEGER,
    last_test_result TEXT CHECK (last_test_result IS NULL OR last_test_result IN ('success', 'failed')),
    last_test_summary TEXT,
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
BEFORE UPDATE OF configuration_key, configuration_version, provider_type,
    credential_ciphertext, credential_nonce, credential_algorithm, credential_key_version, created_at
ON outbound_provider_configs
BEGIN
    SELECT RAISE(ABORT, '服务配置版本与加密凭据不可原地修改');
END;

-- 每个域名同一时刻至多一条生效路线；第一项为默认服务，之后为备用服务。
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
    ON domain_outbound_routes (mail_domain_id) WHERE route_status = 'active';
CREATE INDEX domain_outbound_routes_domain_index
    ON domain_outbound_routes (mail_domain_id, route_version DESC);

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
    WHERE route.id = NEW.route_id AND route.route_status = 'draft'
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
WHEN NEW.route_status = 'active' AND OLD.route_status = 'draft'
  AND NOT EXISTS (SELECT 1 FROM domain_outbound_route_entries WHERE route_id = NEW.id)
BEGIN
    SELECT RAISE(ABORT, '启用发信路线前必须至少配置一家服务');
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

-- 每次站外发信冻结整条路线，旧邮件不会受管理员以后调整影响。
CREATE TABLE outbound_route_snapshots (
    id TEXT PRIMARY KEY NOT NULL,
    mail_domain_id TEXT NOT NULL,
    source_route_id TEXT NOT NULL,
    source_route_version INTEGER NOT NULL CHECK (source_route_version >= 1),
    execution_kind TEXT NOT NULL CHECK (execution_kind IN ('send', 'forward', 'external_email_verification')),
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

CREATE TABLE outbound_route_snapshot_entries (
    id TEXT PRIMARY KEY NOT NULL,
    route_snapshot_id TEXT NOT NULL,
    priority_number INTEGER NOT NULL CHECK (priority_number >= 0),
    provider_config_id TEXT NOT NULL,
    configuration_key TEXT NOT NULL CHECK (length(configuration_key) > 0),
    configuration_version INTEGER NOT NULL CHECK (configuration_version >= 1),
    provider_type TEXT NOT NULL CHECK (provider_type IN ('resend', 'smtp2go')),
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

CREATE TRIGGER prevent_outbound_route_snapshot_change
BEFORE UPDATE ON outbound_route_snapshots
BEGIN
    SELECT RAISE(ABORT, '发信路线快照不可修改');
END;

CREATE TRIGGER prevent_outbound_route_snapshot_entry_change
BEFORE UPDATE ON outbound_route_snapshot_entries
BEGIN
    SELECT RAISE(ABORT, '冻结后的路线快照条目不可修改');
END;

-- 配额策略使用版本化记录。初始每日收件人限额为 500；域名月度默认不限制。
CREATE TABLE quota_policies (
    id TEXT PRIMARY KEY NOT NULL,
    quota_kind TEXT NOT NULL CHECK (
        quota_kind IN ('daily_send_recipients', 'domain_monthly_send_recipients')
    ),
    scope_type TEXT NOT NULL CHECK (scope_type IN ('system_default', 'user', 'domain')),
    user_id TEXT,
    mail_domain_id TEXT,
    policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
    limit_value INTEGER CHECK (limit_value IS NULL OR limit_value >= 1),
    policy_status TEXT NOT NULL CHECK (policy_status IN ('active', 'retired')),
    effective_at INTEGER NOT NULL,
    retired_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (scope_type = 'system_default' AND user_id IS NULL AND mail_domain_id IS NULL)
        OR (scope_type = 'user' AND user_id IS NOT NULL AND mail_domain_id IS NULL)
        OR (scope_type = 'domain' AND user_id IS NULL AND mail_domain_id IS NOT NULL)
    ),
    CHECK (
        (quota_kind = 'daily_send_recipients' AND scope_type IN ('system_default', 'user') AND limit_value IS NOT NULL)
        OR (quota_kind = 'domain_monthly_send_recipients' AND scope_type IN ('system_default', 'domain'))
    ),
    CHECK (
        (policy_status = 'active' AND retired_at IS NULL)
        OR (policy_status = 'retired' AND retired_at IS NOT NULL AND retired_at >= effective_at)
    ),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (mail_domain_id) REFERENCES mail_domains (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX quota_policies_active_system_unique
    ON quota_policies (quota_kind) WHERE scope_type = 'system_default' AND policy_status = 'active';
CREATE UNIQUE INDEX quota_policies_active_user_unique
    ON quota_policies (quota_kind, user_id) WHERE scope_type = 'user' AND policy_status = 'active';
CREATE UNIQUE INDEX quota_policies_active_domain_unique
    ON quota_policies (quota_kind, mail_domain_id) WHERE scope_type = 'domain' AND policy_status = 'active';

INSERT INTO quota_policies (
    id, quota_kind, scope_type, user_id, mail_domain_id, policy_version,
    limit_value, policy_status, effective_at, retired_at, created_at, updated_at
) VALUES
    ('system-daily-send-v1', 'daily_send_recipients', 'system_default', NULL, NULL, 1, 500, 'active', 0, NULL, 0, 0),
    ('system-domain-monthly-send-v1', 'domain_monthly_send_recipients', 'system_default', NULL, NULL, 1, NULL, 'active', 0, NULL, 0, 0);

CREATE TABLE domain_monthly_usage_periods (
    id TEXT PRIMARY KEY NOT NULL,
    mail_domain_id TEXT NOT NULL,
    period_start_at INTEGER NOT NULL,
    period_end_at INTEGER NOT NULL,
    timezone_name TEXT NOT NULL CHECK (length(timezone_name) > 0),
    quota_policy_id TEXT NOT NULL,
    quota_limit_snapshot INTEGER CHECK (quota_limit_snapshot IS NULL OR quota_limit_snapshot >= 1),
    committed_units INTEGER NOT NULL DEFAULT 0 CHECK (committed_units >= 0),
    reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
    unknown_held_units INTEGER NOT NULL DEFAULT 0 CHECK (unknown_held_units >= 0),
    period_status TEXT NOT NULL CHECK (period_status IN ('open', 'closed')),
    closed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (mail_domain_id, period_start_at),
    CHECK (period_end_at > period_start_at),
    CHECK (updated_at >= created_at),
    FOREIGN KEY (mail_domain_id) REFERENCES mail_domains (id) ON DELETE CASCADE,
    FOREIGN KEY (quota_policy_id) REFERENCES quota_policies (id) ON DELETE RESTRICT
);

CREATE INDEX domain_monthly_usage_periods_open_index
    ON domain_monthly_usage_periods (period_status, period_end_at, mail_domain_id);

CREATE TABLE send_operations (
    id TEXT PRIMARY KEY NOT NULL,
    operator_user_id TEXT NOT NULL,
    source_draft_id TEXT,
    source_draft_reference TEXT NOT NULL CHECK (length(source_draft_reference) > 0),
    source_draft_revision_number INTEGER NOT NULL CHECK (source_draft_revision_number >= 1),
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
        OR (compose_kind IN ('reply', 'reply_all', 'forward') AND source_reference IS NOT NULL)
    ),
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
    FOREIGN KEY (outbound_route_snapshot_id) REFERENCES outbound_route_snapshots (id) ON DELETE RESTRICT,
    FOREIGN KEY (final_mime_object_id) REFERENCES object_registry (id) ON DELETE RESTRICT
);

CREATE INDEX send_operations_operator_index
    ON send_operations (operator_user_id, accepted_at DESC, id DESC);
CREATE INDEX send_operations_work_index
    ON send_operations (workflow_status, accepted_at, id);

CREATE TRIGGER validate_send_operation_insert
BEFORE INSERT ON send_operations
WHEN NOT EXISTS (
    SELECT 1
    FROM users AS operator
    JOIN messages AS message
      ON message.id = NEW.message_id AND message.origin_type = 'composed'
     AND message.authored_by_user_id = NEW.operator_user_id
    JOIN drafts AS source_draft
      ON source_draft.id = NEW.source_draft_id
     AND source_draft.owner_user_id = NEW.operator_user_id
     AND source_draft.status = 'active'
     AND source_draft.current_revision_number = NEW.source_draft_revision_number
    JOIN mailbox_entries AS entry
      ON entry.id = NEW.sent_mailbox_entry_id AND entry.message_id = NEW.message_id
     AND entry.entry_kind = 'sent' AND entry.base_location = 'sent'
     AND entry.mailbox_type = NEW.sent_mailbox_type
     AND ((NEW.sent_mailbox_type = 'user' AND entry.user_id = NEW.sent_user_id)
       OR (NEW.sent_mailbox_type = 'organization' AND entry.organization_id = NEW.sent_organization_id))
    JOIN address_bindings AS binding
      ON binding.id = NEW.sender_address_binding_id AND binding.address_id = NEW.sender_address_id
     AND binding.started_at <= NEW.accepted_at
     AND (binding.ended_at IS NULL OR binding.ended_at >= NEW.accepted_at)
    JOIN email_addresses AS address ON address.id = NEW.sender_address_id AND address.retired_at IS NULL
    JOIN address_claims AS sender_claim
      ON sender_claim.address_id = address.id AND sender_claim.status = 'active'
    JOIN mail_domains AS domain ON domain.id = address.domain_id AND domain.status = 'active'
    JOIN message_integrity_states AS integrity
      ON integrity.message_id = NEW.message_id AND integrity.integrity_status = 'ready'
     AND integrity.source_completeness = 'final_mime'
    JOIN object_registry AS object
      ON object.id = NEW.final_mime_object_id AND object.message_id = NEW.message_id
     AND object.object_role = 'final_mime' AND object.is_current = 1
     AND object.object_status = 'active' AND object.actual_size_bytes = NEW.payload_size_bytes
     AND object.actual_sha256 = NEW.payload_sha256
    LEFT JOIN outbound_route_snapshots AS snapshot
      ON snapshot.id = NEW.outbound_route_snapshot_id AND snapshot.execution_kind = 'send'
     AND snapshot.execution_reference = NEW.id AND snapshot.mail_domain_id = domain.id
     AND snapshot.payload_sha256 = NEW.payload_sha256
     AND snapshot.payload_size_bytes = NEW.payload_size_bytes
    WHERE operator.id = NEW.operator_user_id AND operator.status = 'active'
      AND ((NEW.external_recipient_count = 0 AND snapshot.id IS NULL)
        OR (NEW.external_recipient_count > 0 AND snapshot.id IS NOT NULL))
      AND (
          (NEW.sent_mailbox_type = 'user' AND binding.owner_type = 'user'
            AND binding.user_id = NEW.operator_user_id)
          OR (NEW.sent_mailbox_type = 'organization' AND binding.owner_type = 'organization'
            AND binding.organization_id = NEW.sent_organization_id
            AND EXISTS (
                SELECT 1 FROM organizations AS organization
                WHERE organization.id = NEW.sent_organization_id AND organization.status = 'active'
                  AND (organization.creator_user_id = NEW.operator_user_id
                    OR (organization.members_can_send = 1 AND EXISTS (
                        SELECT 1 FROM organization_memberships AS membership
                        WHERE membership.organization_id = organization.id
                          AND membership.user_id = NEW.operator_user_id AND membership.left_at IS NULL
                    )))
            ))
      )
)
BEGIN
    SELECT RAISE(ABORT, '发送操作的权限、MIME或冻结路线无效');
END;

CREATE TRIGGER validate_daily_send_quota
BEFORE INSERT ON send_operations
WHEN NEW.quota_recipient_units + COALESCE((
    SELECT SUM(existing.quota_recipient_units)
    FROM send_operations AS existing
    WHERE existing.operator_user_id = NEW.operator_user_id
      AND existing.accepted_at > NEW.accepted_at - 86400000
), 0) > COALESCE((
    SELECT limit_value FROM quota_policies
    WHERE quota_kind = 'daily_send_recipients' AND scope_type = 'user'
      AND user_id = NEW.operator_user_id AND policy_status = 'active'
), (
    SELECT limit_value FROM quota_policies
    WHERE quota_kind = 'daily_send_recipients' AND scope_type = 'system_default'
      AND policy_status = 'active'
))
BEGIN
    SELECT RAISE(ABORT, '用户过去24小时的发件收件人额度不足');
END;

CREATE TRIGGER prevent_send_operation_identity_change
BEFORE UPDATE OF operator_user_id, source_draft_reference, source_draft_revision_number,
    message_id, sent_mailbox_entry_id, sender_address_id, sender_address_binding_id,
    sent_mailbox_type, sent_user_id, sent_organization_id, compose_kind, source_reference,
    recipient_count, internal_recipient_count, external_recipient_count, quota_recipient_units,
    payload_sha256, payload_size_bytes, effective_size_limit_bytes,
    outbound_route_snapshot_id, accepted_at, created_at, final_mime_object_id
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

CREATE TRIGGER prevent_send_idempotency_key_change
BEFORE UPDATE ON send_idempotency_keys
BEGIN
    SELECT RAISE(ABORT, '发送防重记录不可修改');
END;

CREATE TABLE send_recipients (
    id TEXT PRIMARY KEY NOT NULL,
    send_operation_id TEXT NOT NULL,
    recipient_role TEXT NOT NULL CHECK (recipient_role IN ('to', 'cc', 'bcc')),
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
    display_name TEXT,
    address_text TEXT NOT NULL CHECK (length(address_text) > 0),
    canonical_address TEXT NOT NULL CHECK (instr(canonical_address, '@') > 1),
    deduplication_key BLOB NOT NULL CHECK (length(deduplication_key) = 32),
    route_channel TEXT NOT NULL CHECK (route_channel IN ('internal_assigned', 'external')),
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
        (route_channel = 'internal_assigned' AND message_delivery_id IS NOT NULL AND delivery_status = 'delivered')
        OR (route_channel = 'external' AND message_delivery_id IS NULL)
    ),
    FOREIGN KEY (send_operation_id) REFERENCES send_operations (id) ON DELETE CASCADE,
    FOREIGN KEY (message_delivery_id) REFERENCES message_deliveries (id) ON DELETE RESTRICT
);

CREATE INDEX send_recipients_status_index
    ON send_recipients (delivery_status, status_updated_at, id);
CREATE INDEX send_recipients_operation_channel_index
    ON send_recipients (send_operation_id, route_channel, recipient_role, sequence_number);

CREATE TRIGGER prevent_send_recipient_identity_change
BEFORE UPDATE OF send_operation_id, recipient_role, sequence_number, display_name,
    address_text, canonical_address, deduplication_key, route_channel, message_delivery_id, created_at
ON send_recipients
BEGIN
    SELECT RAISE(ABORT, '逻辑收件人身份不可修改');
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

CREATE TABLE send_recipient_status_history (
    id TEXT PRIMARY KEY NOT NULL,
    send_recipient_id TEXT NOT NULL,
    previous_status TEXT,
    new_status TEXT NOT NULL CHECK (
        new_status IN ('waiting', 'submitting', 'submitted', 'delayed', 'delivered', 'bounced', 'failed', 'unknown')
    ),
    status_version INTEGER NOT NULL CHECK (status_version >= 1),
    source_type TEXT NOT NULL CHECK (
        source_type IN ('send_acceptance', 'provider_attempt', 'provider_event', 'permission_revoked', 'manual_reconciliation')
    ),
    source_reference TEXT NOT NULL CHECK (length(source_reference) > 0),
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (send_recipient_id, status_version),
    UNIQUE (send_recipient_id, source_type, source_reference),
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
        last_switch_reason IS NULL OR last_switch_reason IN (
            'service_unavailable', 'size_incompatible', 'temporary_rejection', 'configuration_disabled'
        )
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
    WHERE recipient.id = NEW.send_recipient_id AND recipient.route_channel = 'external'
)
BEGIN
    SELECT RAISE(ABORT, '只有站外收件人可以建立匹配发送操作的路线进度');
END;

CREATE TRIGGER validate_send_recipient_route_progress_update
BEFORE UPDATE OF next_priority_number, selected_route_snapshot_entry_id, progress_status
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
    idempotency_key_digest BLOB CHECK (
        idempotency_key_digest IS NULL OR length(idempotency_key_digest) = 32
    ),
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
        OR (attempt_status IN ('accepted', 'not_accepted', 'unknown')
            AND started_at IS NOT NULL AND completed_at IS NOT NULL AND completed_at >= started_at)
    ),
    FOREIGN KEY (send_operation_id) REFERENCES send_operations (id) ON DELETE CASCADE,
    FOREIGN KEY (route_snapshot_entry_id) REFERENCES outbound_route_snapshot_entries (id) ON DELETE RESTRICT
);

CREATE INDEX outbound_submission_attempts_work_index
    ON outbound_submission_attempts (attempt_status, created_at, id);

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
        fallback_reason IS NULL OR fallback_reason IN (
            'service_unavailable', 'size_incompatible', 'temporary_rejection', 'configuration_disabled'
        )
    ),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (outbound_submission_attempt_id, send_recipient_id),
    CHECK (
        (selection_kind = 'fallback' AND fallback_reason IS NOT NULL)
        OR (selection_kind <> 'fallback' AND fallback_reason IS NULL)
    ),
    FOREIGN KEY (outbound_submission_attempt_id) REFERENCES outbound_submission_attempts (id) ON DELETE CASCADE,
    FOREIGN KEY (send_recipient_id) REFERENCES send_recipients (id) ON DELETE CASCADE
);

CREATE INDEX outbound_submission_attempt_recipients_recipient_index
    ON outbound_submission_attempt_recipients (send_recipient_id, outbound_submission_attempt_id);

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

CREATE TABLE outbound_provider_events (
    id TEXT PRIMARY KEY NOT NULL,
    provider_type TEXT NOT NULL CHECK (provider_type IN ('resend', 'smtp2go')),
    provider_event_id TEXT NOT NULL CHECK (length(provider_event_id) > 0),
    normalized_event_type TEXT NOT NULL CHECK (
        normalized_event_type IN (
            'submitted', 'delayed', 'delivered', 'bounced', 'failed',
            'complained', 'opened', 'clicked', 'other'
        )
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
    processing_result TEXT NOT NULL CHECK (
        processing_result IN ('pending', 'applied', 'no_change', 'ignored', 'rejected')
    ),
    processed_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (provider_type, provider_event_id),
    CHECK (verified_at >= received_at),
    FOREIGN KEY (outbound_submission_attempt_id) REFERENCES outbound_submission_attempts (id) ON DELETE SET NULL,
    FOREIGN KEY (send_recipient_id) REFERENCES send_recipients (id) ON DELETE SET NULL
);

CREATE INDEX outbound_provider_events_pending_index
    ON outbound_provider_events (match_status, received_at, id) WHERE match_status = 'pending';

CREATE TRIGGER prevent_outbound_provider_event_identity_change
BEFORE UPDATE OF provider_type, provider_event_id, normalized_event_type, occurred_at,
    received_at, verified_at, raw_sha256, diagnostic_code, diagnostic_summary, created_at
ON outbound_provider_events
BEGIN
    SELECT RAISE(ABORT, '已验证供应商事件事实不可修改');
END;

CREATE TABLE domain_monthly_usage_reservations (
    id TEXT PRIMARY KEY NOT NULL,
    domain_monthly_usage_period_id TEXT NOT NULL,
    send_recipient_id TEXT NOT NULL UNIQUE,
    usage_status TEXT NOT NULL CHECK (
        usage_status IN ('reserved', 'committed', 'released', 'unknown_held')
    ),
    reserved_at INTEGER NOT NULL,
    committed_at INTEGER,
    released_at INTEGER,
    unknown_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (usage_status = 'reserved' AND committed_at IS NULL AND released_at IS NULL AND unknown_at IS NULL)
        OR (usage_status = 'committed' AND committed_at IS NOT NULL AND released_at IS NULL AND unknown_at IS NULL)
        OR (usage_status = 'released' AND committed_at IS NULL AND released_at IS NOT NULL AND unknown_at IS NULL)
        OR (usage_status = 'unknown_held' AND committed_at IS NULL AND released_at IS NULL AND unknown_at IS NOT NULL)
    ),
    FOREIGN KEY (domain_monthly_usage_period_id) REFERENCES domain_monthly_usage_periods (id) ON DELETE CASCADE,
    FOREIGN KEY (send_recipient_id) REFERENCES send_recipients (id) ON DELETE CASCADE
);

CREATE INDEX domain_monthly_usage_reservations_period_index
    ON domain_monthly_usage_reservations (domain_monthly_usage_period_id, usage_status, id);

CREATE TRIGGER validate_domain_monthly_reservation_insert
BEFORE INSERT ON domain_monthly_usage_reservations
WHEN NOT EXISTS (
    SELECT 1
    FROM domain_monthly_usage_periods AS period
    JOIN send_recipients AS recipient ON recipient.id = NEW.send_recipient_id
    JOIN send_operations AS operation ON operation.id = recipient.send_operation_id
    JOIN email_addresses AS sender ON sender.id = operation.sender_address_id
    WHERE period.id = NEW.domain_monthly_usage_period_id AND period.period_status = 'open'
      AND sender.domain_id = period.mail_domain_id
      AND (period.quota_limit_snapshot IS NULL
        OR period.committed_units + period.reserved_units + period.unknown_held_units + 1
          <= period.quota_limit_snapshot)
)
BEGIN
    SELECT RAISE(ABORT, '域名月度发件配额不足或发件域名不匹配');
END;

CREATE TRIGGER apply_domain_monthly_reservation_insert
AFTER INSERT ON domain_monthly_usage_reservations
WHEN NEW.usage_status = 'reserved'
BEGIN
    UPDATE domain_monthly_usage_periods
    SET reserved_units = reserved_units + 1, updated_at = NEW.updated_at
    WHERE id = NEW.domain_monthly_usage_period_id;
END;

CREATE TRIGGER apply_domain_monthly_committed_insert
AFTER INSERT ON domain_monthly_usage_reservations
WHEN NEW.usage_status = 'committed'
BEGIN
    UPDATE domain_monthly_usage_periods
    SET committed_units = committed_units + 1, updated_at = NEW.updated_at
    WHERE id = NEW.domain_monthly_usage_period_id;
END;

CREATE TRIGGER validate_domain_monthly_usage_transition
BEFORE UPDATE OF usage_status ON domain_monthly_usage_reservations
WHEN NOT (
    (OLD.usage_status = 'reserved' AND NEW.usage_status IN ('committed', 'released', 'unknown_held'))
    OR (OLD.usage_status = 'unknown_held' AND NEW.usage_status IN ('committed', 'released'))
)
BEGIN
    SELECT RAISE(ABORT, '域名月度用量状态迁移无效');
END;

CREATE TRIGGER apply_domain_monthly_reserved_transition
AFTER UPDATE OF usage_status ON domain_monthly_usage_reservations
WHEN OLD.usage_status = 'reserved'
BEGIN
    UPDATE domain_monthly_usage_periods
    SET reserved_units = reserved_units - 1,
        committed_units = committed_units + CASE WHEN NEW.usage_status = 'committed' THEN 1 ELSE 0 END,
        unknown_held_units = unknown_held_units + CASE WHEN NEW.usage_status = 'unknown_held' THEN 1 ELSE 0 END,
        updated_at = NEW.updated_at
    WHERE id = NEW.domain_monthly_usage_period_id;
END;

CREATE TRIGGER apply_domain_monthly_unknown_transition
AFTER UPDATE OF usage_status ON domain_monthly_usage_reservations
WHEN OLD.usage_status = 'unknown_held'
BEGIN
    UPDATE domain_monthly_usage_periods
    SET unknown_held_units = unknown_held_units - 1,
        committed_units = committed_units + CASE WHEN NEW.usage_status = 'committed' THEN 1 ELSE 0 END,
        updated_at = NEW.updated_at
    WHERE id = NEW.domain_monthly_usage_period_id;
END;
