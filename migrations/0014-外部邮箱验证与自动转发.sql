-- 澄笺 | Simlettra 外部邮箱验证与自动转发

PRAGMA foreign_keys = ON;

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
    CHECK ((target_status = 'verified' AND verified_at IS NOT NULL AND disabled_at IS NULL AND deleted_at IS NULL)
        OR target_status <> 'verified'),
    CHECK ((target_status = 'disabled' AND disabled_at IS NOT NULL AND deleted_at IS NULL)
        OR target_status <> 'disabled'),
    CHECK ((target_status = 'deleted' AND deleted_at IS NOT NULL)
        OR target_status <> 'deleted'),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX external_email_targets_current_unique
    ON external_email_targets (user_id, canonical_email_address)
    WHERE target_status <> 'deleted';

CREATE INDEX external_email_targets_user_index
    ON external_email_targets (user_id, target_status, created_at DESC, id);

CREATE TRIGGER validate_external_email_target_insert
BEFORE INSERT ON external_email_targets
WHEN EXISTS (
    SELECT 1 FROM mail_domains AS domain
    WHERE domain.canonical_name = substr(
        NEW.canonical_email_address,
        instr(NEW.canonical_email_address, '@') + 1
    ) COLLATE NOCASE
      AND domain.status <> 'deleted'
)
BEGIN
    SELECT RAISE(ABORT, '外部邮箱不能使用本系统管理的邮件域名');
END;

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
    verification_code_salt BLOB NOT NULL CHECK (length(verification_code_salt) = 16),
    expires_at INTEGER NOT NULL,
    max_failure_count INTEGER NOT NULL CHECK (max_failure_count BETWEEN 1 AND 10),
    failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    verification_status TEXT NOT NULL CHECK (
        verification_status IN (
            'pending_delivery', 'submitting', 'pending_input',
            'delivery_failed', 'delivery_unknown', 'verified',
            'expired', 'cancelled'
        )
    ),
    outbound_route_snapshot_id TEXT NOT NULL UNIQUE,
    delivered_at INTEGER,
    verified_at INTEGER,
    completed_at INTEGER,
    error_code TEXT,
    error_summary TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (expires_at > created_at),
    CHECK (failure_count <= max_failure_count),
    CHECK ((verification_status = 'pending_input' AND delivered_at IS NOT NULL)
        OR verification_status <> 'pending_input'),
    CHECK ((verification_status = 'verified' AND verified_at IS NOT NULL AND completed_at IS NOT NULL)
        OR verification_status <> 'verified'),
    CHECK ((verification_status IN ('delivery_failed', 'delivery_unknown', 'expired', 'cancelled')
            AND completed_at IS NOT NULL)
        OR verification_status NOT IN ('delivery_failed', 'delivery_unknown', 'expired', 'cancelled')),
    FOREIGN KEY (external_email_target_id) REFERENCES external_email_targets (id) ON DELETE RESTRICT,
    FOREIGN KEY (outbound_route_snapshot_id) REFERENCES outbound_route_snapshots (id) ON DELETE RESTRICT
);

CREATE INDEX external_email_verifications_target_index
    ON external_email_verifications (external_email_target_id, verification_status, created_at DESC, id);

CREATE TRIGGER validate_external_email_verification_snapshot_insert
BEFORE INSERT ON external_email_verifications
WHEN NOT EXISTS (
    SELECT 1 FROM outbound_route_snapshots AS snapshot
    WHERE snapshot.id = NEW.outbound_route_snapshot_id
      AND snapshot.execution_kind = 'external_email_verification'
      AND snapshot.execution_reference = NEW.id
)
BEGIN
    SELECT RAISE(ABORT, '外部邮箱验证必须引用自己的冻结发信路线');
END;

CREATE TRIGGER prevent_external_email_verification_identity_change
BEFORE UPDATE OF external_email_target_id, verification_code_hash, verification_code_salt,
    expires_at, max_failure_count, outbound_route_snapshot_id, created_at
ON external_email_verifications
BEGIN
    SELECT RAISE(ABORT, '外部邮箱验证的冻结字段不可修改');
END;

CREATE TRIGGER validate_external_email_verification_transition
BEFORE UPDATE OF verification_status ON external_email_verifications
WHEN NEW.verification_status <> OLD.verification_status
  AND NOT (
      (OLD.verification_status = 'pending_delivery' AND NEW.verification_status IN ('submitting', 'delivery_failed', 'cancelled'))
      OR (OLD.verification_status = 'submitting' AND NEW.verification_status IN ('pending_input', 'delivery_failed', 'delivery_unknown'))
      OR (OLD.verification_status = 'pending_input' AND NEW.verification_status IN ('verified', 'expired', 'cancelled'))
  )
BEGIN
    SELECT RAISE(ABORT, '外部邮箱验证状态不能倒退或重复使用');
END;

CREATE TABLE external_email_verification_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    external_email_verification_id TEXT NOT NULL,
    route_snapshot_entry_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    selection_kind TEXT NOT NULL CHECK (selection_kind IN ('initial', 'fallback')),
    fallback_reason TEXT CHECK (fallback_reason IS NULL OR fallback_reason IN ('temporary_rejection', 'configuration_disabled')),
    attempt_status TEXT NOT NULL CHECK (attempt_status IN ('prepared', 'submitting', 'accepted', 'not_accepted', 'unknown')),
    provider_submission_id TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    error_code TEXT,
    error_summary TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (external_email_verification_id, attempt_number),
    CHECK (updated_at >= created_at),
    CHECK ((selection_kind = 'fallback' AND fallback_reason IS NOT NULL)
        OR (selection_kind = 'initial' AND fallback_reason IS NULL)),
    CHECK ((attempt_status = 'prepared' AND started_at IS NULL AND completed_at IS NULL)
      OR (attempt_status = 'submitting' AND started_at IS NOT NULL AND completed_at IS NULL)
      OR (attempt_status IN ('accepted', 'not_accepted', 'unknown') AND started_at IS NOT NULL AND completed_at IS NOT NULL)),
    FOREIGN KEY (external_email_verification_id) REFERENCES external_email_verifications (id) ON DELETE CASCADE,
    FOREIGN KEY (route_snapshot_entry_id) REFERENCES outbound_route_snapshot_entries (id) ON DELETE RESTRICT
);

CREATE TRIGGER validate_external_email_verification_attempt_insert
BEFORE INSERT ON external_email_verification_attempts
WHEN NOT EXISTS (
    SELECT 1
    FROM external_email_verifications AS verification
    JOIN outbound_route_snapshot_entries AS entry
      ON entry.id = NEW.route_snapshot_entry_id
     AND entry.route_snapshot_id = verification.outbound_route_snapshot_id
    WHERE verification.id = NEW.external_email_verification_id
)
BEGIN
    SELECT RAISE(ABORT, '验证邮件尝试与冻结路线不匹配');
END;

CREATE TRIGGER prevent_external_email_verification_fallback_after_unknown
BEFORE INSERT ON external_email_verification_attempts
WHEN NEW.selection_kind = 'fallback'
  AND EXISTS (
      SELECT 1 FROM external_email_verification_attempts AS previous
      WHERE previous.external_email_verification_id = NEW.external_email_verification_id
        AND previous.attempt_status = 'unknown'
  )
BEGIN
    SELECT RAISE(ABORT, '验证邮件结果未知时不得自动切换备用服务');
END;

CREATE TABLE mail_forwarding_rules (
    id TEXT PRIMARY KEY NOT NULL,
    rule_key TEXT NOT NULL,
    user_id TEXT NOT NULL,
    external_email_target_id TEXT NOT NULL,
    rule_version INTEGER NOT NULL CHECK (rule_version >= 1),
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('all_personal', 'selected_personal_addresses')),
    rule_status TEXT NOT NULL CHECK (rule_status IN ('active', 'paused', 'superseded', 'deleted')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    superseded_at INTEGER,
    deleted_at INTEGER,
    UNIQUE (rule_key, rule_version),
    CHECK (updated_at >= created_at),
    CHECK ((rule_status = 'superseded' AND superseded_at IS NOT NULL) OR rule_status <> 'superseded'),
    CHECK ((rule_status = 'deleted' AND deleted_at IS NOT NULL) OR rule_status <> 'deleted'),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (external_email_target_id) REFERENCES external_email_targets (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX mail_forwarding_rules_current_unique
    ON mail_forwarding_rules (rule_key)
    WHERE rule_status IN ('active', 'paused');

CREATE INDEX mail_forwarding_rules_user_index
    ON mail_forwarding_rules (user_id, rule_status, updated_at DESC, id);

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
BEFORE UPDATE OF rule_key, user_id, external_email_target_id, rule_version, scope_kind, created_at
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
    sender_address TEXT NOT NULL CHECK (instr(sender_address, '@') > 1),
    target_canonical_email_address TEXT COLLATE NOCASE NOT NULL CHECK (instr(target_canonical_email_address, '@') > 1),
    payload_sha256 BLOB NOT NULL CHECK (length(payload_sha256) = 32),
    payload_size_bytes INTEGER NOT NULL CHECK (payload_size_bytes >= 0),
    forwarding_hop_count INTEGER NOT NULL CHECK (forwarding_hop_count BETWEEN 1 AND 5),
    source_marked_by_simlettra INTEGER NOT NULL DEFAULT 0 CHECK (source_marked_by_simlettra IN (0, 1)),
    outbound_route_snapshot_id TEXT UNIQUE,
    operation_status TEXT NOT NULL CHECK (operation_status IN ('pending', 'submitting', 'submitted', 'failed', 'unknown', 'cancelled', 'rejected_loop')),
    provider_reference TEXT,
    error_code TEXT,
    error_summary TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    UNIQUE (message_delivery_id, mail_forwarding_rule_id, rule_version, external_email_target_id),
    CHECK (updated_at >= created_at),
    CHECK ((operation_status IN ('submitted', 'failed', 'unknown', 'cancelled', 'rejected_loop') AND completed_at IS NOT NULL)
        OR (operation_status IN ('pending', 'submitting') AND completed_at IS NULL)),
    CHECK ((operation_status = 'rejected_loop' AND error_code IS NOT NULL AND outbound_route_snapshot_id IS NULL)
        OR operation_status <> 'rejected_loop'),
    CHECK ((operation_status IN ('pending', 'submitting', 'submitted', 'unknown') AND outbound_route_snapshot_id IS NOT NULL)
        OR operation_status NOT IN ('pending', 'submitting', 'submitted', 'unknown')),
    CHECK ((source_marked_by_simlettra = 0 AND forwarding_hop_count <= 5) OR operation_status = 'rejected_loop'),
    FOREIGN KEY (source_message_id) REFERENCES messages (id) ON DELETE RESTRICT,
    FOREIGN KEY (message_delivery_id) REFERENCES message_deliveries (id) ON DELETE RESTRICT,
    FOREIGN KEY (mail_forwarding_rule_id) REFERENCES mail_forwarding_rules (id) ON DELETE RESTRICT,
    FOREIGN KEY (external_email_target_id) REFERENCES external_email_targets (id) ON DELETE RESTRICT,
    FOREIGN KEY (outbound_route_snapshot_id) REFERENCES outbound_route_snapshots (id) ON DELETE RESTRICT
);

CREATE INDEX mail_forward_operations_user_result_index
    ON mail_forward_operations (mail_forwarding_rule_id, created_at DESC, id);

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
    JOIN address_bindings AS binding
      ON binding.id = delivery.address_binding_id
     AND binding.owner_type = 'user'
     AND binding.user_id = rule.user_id
     AND binding.ended_at IS NULL
    JOIN email_addresses AS sender ON sender.id = binding.address_id
    WHERE delivery.id = NEW.message_delivery_id
      AND delivery.message_id = NEW.source_message_id
      AND sender.canonical_address = NEW.sender_address COLLATE NOCASE
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
    SELECT RAISE(ABORT, '转发操作与个人投递、规则或目标不匹配');
END;

CREATE TRIGGER validate_mail_forward_operation_snapshot_insert
BEFORE INSERT ON mail_forward_operations
WHEN NEW.outbound_route_snapshot_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM outbound_route_snapshots AS snapshot
      WHERE snapshot.id = NEW.outbound_route_snapshot_id
        AND snapshot.execution_kind = 'forward'
        AND snapshot.execution_reference = NEW.id
        AND snapshot.payload_sha256 = NEW.payload_sha256
        AND snapshot.payload_size_bytes = NEW.payload_size_bytes
  )
BEGIN
    SELECT RAISE(ABORT, '转发操作与冻结路线不匹配');
END;

CREATE TRIGGER prevent_mail_forward_operation_identity_change
BEFORE UPDATE OF source_message_id, message_delivery_id, mail_forwarding_rule_id, rule_version,
    external_email_target_id, sender_address, target_canonical_email_address,
    payload_sha256, payload_size_bytes, forwarding_hop_count,
    source_marked_by_simlettra, outbound_route_snapshot_id, created_at
ON mail_forward_operations
BEGIN
    SELECT RAISE(ABORT, '转发操作的冻结身份不可修改');
END;

CREATE TRIGGER validate_mail_forward_operation_transition
BEFORE UPDATE OF operation_status ON mail_forward_operations
WHEN NEW.operation_status <> OLD.operation_status
  AND NOT (
      (OLD.operation_status = 'pending' AND NEW.operation_status IN ('submitting', 'failed', 'cancelled'))
      OR (OLD.operation_status = 'submitting' AND NEW.operation_status IN ('submitted', 'failed', 'unknown'))
  )
BEGIN
    SELECT RAISE(ABORT, '转发操作状态不能倒退');
END;

CREATE TABLE mail_forward_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    mail_forward_operation_id TEXT NOT NULL,
    route_snapshot_entry_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    selection_kind TEXT NOT NULL CHECK (selection_kind IN ('initial', 'fallback')),
    fallback_reason TEXT CHECK (fallback_reason IS NULL OR fallback_reason IN ('temporary_rejection', 'configuration_disabled')),
    attempt_status TEXT NOT NULL CHECK (attempt_status IN ('prepared', 'submitting', 'accepted', 'not_accepted', 'unknown')),
    provider_submission_id TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    error_code TEXT,
    error_summary TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (mail_forward_operation_id, attempt_number),
    CHECK (updated_at >= created_at),
    CHECK ((selection_kind = 'fallback' AND fallback_reason IS NOT NULL)
        OR (selection_kind = 'initial' AND fallback_reason IS NULL)),
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
BEFORE UPDATE OF mail_forward_operation_id, route_snapshot_entry_id, attempt_number,
    selection_kind, fallback_reason, created_at
ON mail_forward_attempts
BEGIN
    SELECT RAISE(ABORT, '转发尝试身份不可修改');
END;
