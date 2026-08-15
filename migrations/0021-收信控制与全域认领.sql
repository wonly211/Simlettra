-- 澄笺 | Simlettra 正式迁移 0021
-- 依据：需求 5.06 至 5.10、ADR 0018、0023、0043。

PRAGMA foreign_keys = ON;

-- 缺少记录表示沿用“允许收信”。显式记录用于独立暂停域名、地址或用户的收信，
-- 不改变域名分配、用户登录或地址发信等其他能力。
CREATE TABLE inbound_receive_controls (
    id TEXT PRIMARY KEY NOT NULL,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('domain', 'address', 'user')),
    domain_id TEXT,
    address_id TEXT,
    user_id TEXT,
    receive_status TEXT NOT NULL CHECK (receive_status IN ('accepting', 'paused')),
    updated_by_user_id TEXT NOT NULL,
    paused_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (scope_type = 'domain' AND domain_id IS NOT NULL AND address_id IS NULL AND user_id IS NULL)
        OR (scope_type = 'address' AND domain_id IS NULL AND address_id IS NOT NULL AND user_id IS NULL)
        OR (scope_type = 'user' AND domain_id IS NULL AND address_id IS NULL AND user_id IS NOT NULL)
    ),
    CHECK (
        (receive_status = 'accepting' AND paused_at IS NULL)
        OR (receive_status = 'paused' AND paused_at IS NOT NULL)
    ),
    FOREIGN KEY (domain_id) REFERENCES mail_domains (id) ON DELETE CASCADE,
    FOREIGN KEY (address_id) REFERENCES email_addresses (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX inbound_receive_controls_domain_unique
    ON inbound_receive_controls (domain_id)
    WHERE scope_type = 'domain';

CREATE UNIQUE INDEX inbound_receive_controls_address_unique
    ON inbound_receive_controls (address_id)
    WHERE scope_type = 'address';

CREATE UNIQUE INDEX inbound_receive_controls_user_unique
    ON inbound_receive_controls (user_id)
    WHERE scope_type = 'user';

CREATE INDEX inbound_receive_controls_status_index
    ON inbound_receive_controls (receive_status, scope_type, updated_at, id);

CREATE TRIGGER validate_inbound_receive_control_actor_insert
BEFORE INSERT ON inbound_receive_controls
WHEN NOT EXISTS (
    SELECT 1
    FROM system_instances AS system
    JOIN users AS administrator
      ON administrator.id = system.current_admin_user_id
     AND administrator.status = 'active'
    WHERE system.singleton_id = 1
      AND administrator.id = NEW.updated_by_user_id
)
BEGIN
    SELECT RAISE(ABORT, '只有当前系统管理员可以设置收信暂停');
END;

CREATE TRIGGER validate_inbound_receive_control_actor_update
BEFORE UPDATE ON inbound_receive_controls
WHEN NOT EXISTS (
    SELECT 1
    FROM system_instances AS system
    JOIN users AS administrator
      ON administrator.id = system.current_admin_user_id
     AND administrator.status = 'active'
    WHERE system.singleton_id = 1
      AND administrator.id = NEW.updated_by_user_id
)
BEGIN
    SELECT RAISE(ABORT, '只有当前系统管理员可以更新收信暂停');
END;

CREATE TABLE inbound_rejection_rules (
    id TEXT PRIMARY KEY NOT NULL,
    rule_type TEXT NOT NULL CHECK (
        rule_type IN ('sender_address', 'sender_domain', 'subject_keyword', 'body_keyword')
    ),
    match_value TEXT NOT NULL CHECK (length(match_value) BETWEEN 1 AND 320),
    rule_status TEXT NOT NULL CHECK (rule_status IN ('active', 'paused')),
    created_by_user_id TEXT NOT NULL,
    updated_by_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    UNIQUE (rule_type, match_value),
    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE INDEX inbound_rejection_rules_match_index
    ON inbound_rejection_rules (rule_status, rule_type, match_value, id);

CREATE TRIGGER validate_inbound_rejection_rule_actor_insert
BEFORE INSERT ON inbound_rejection_rules
WHEN NOT EXISTS (
    SELECT 1
    FROM system_instances AS system
    JOIN users AS administrator
      ON administrator.id = system.current_admin_user_id
     AND administrator.status = 'active'
    WHERE system.singleton_id = 1
      AND administrator.id = NEW.created_by_user_id
      AND administrator.id = NEW.updated_by_user_id
)
BEGIN
    SELECT RAISE(ABORT, '只有当前系统管理员可以建立拒收规则');
END;

CREATE TRIGGER validate_inbound_rejection_rule_actor_update
BEFORE UPDATE ON inbound_rejection_rules
WHEN NOT EXISTS (
    SELECT 1
    FROM system_instances AS system
    JOIN users AS administrator
      ON administrator.id = system.current_admin_user_id
     AND administrator.status = 'active'
    WHERE system.singleton_id = 1
      AND administrator.id = NEW.updated_by_user_id
)
BEGIN
    SELECT RAISE(ABORT, '只有当前系统管理员可以更新拒收规则');
END;

CREATE TRIGGER prevent_inbound_rejection_rule_identity_change
BEFORE UPDATE OF rule_type, match_value, created_by_user_id, created_at
ON inbound_rejection_rules
BEGIN
    SELECT RAISE(ABORT, '拒收规则匹配条件不可原地修改，请删除后重新建立');
END;

CREATE TABLE unallocated_address_periods (
    id TEXT PRIMARY KEY NOT NULL,
    domain_id TEXT NOT NULL,
    canonical_address TEXT COLLATE NOCASE NOT NULL,
    display_address TEXT NOT NULL,
    period_status TEXT NOT NULL CHECK (period_status IN ('open', 'claimed', 'closed')),
    started_at INTEGER NOT NULL,
    closed_at INTEGER,
    claimed_by_user_id TEXT,
    claimed_address_id TEXT,
    claimed_address_binding_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (canonical_address = lower(canonical_address)),
    CHECK (display_address = canonical_address),
    CHECK (
        (period_status = 'open'
            AND closed_at IS NULL
            AND claimed_by_user_id IS NULL
            AND claimed_address_id IS NULL
            AND claimed_address_binding_id IS NULL)
        OR (period_status = 'claimed'
            AND closed_at IS NOT NULL
            AND closed_at >= started_at
            AND claimed_by_user_id IS NOT NULL
            AND claimed_address_id IS NOT NULL
            AND claimed_address_binding_id IS NOT NULL)
        OR (period_status = 'closed'
            AND closed_at IS NOT NULL
            AND closed_at >= started_at
            AND claimed_by_user_id IS NULL
            AND claimed_address_id IS NULL
            AND claimed_address_binding_id IS NULL)
    ),
    FOREIGN KEY (domain_id) REFERENCES mail_domains (id) ON DELETE RESTRICT,
    FOREIGN KEY (claimed_by_user_id) REFERENCES users (id) ON DELETE RESTRICT,
    FOREIGN KEY (claimed_address_id) REFERENCES email_addresses (id) ON DELETE RESTRICT,
    FOREIGN KEY (claimed_address_binding_id) REFERENCES address_bindings (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX unallocated_address_periods_open_unique
    ON unallocated_address_periods (canonical_address)
    WHERE period_status = 'open';

CREATE INDEX unallocated_address_periods_domain_index
    ON unallocated_address_periods (domain_id, period_status, started_at DESC, id DESC);

CREATE TRIGGER prevent_unallocated_period_identity_change
BEFORE UPDATE OF domain_id, canonical_address, display_address, started_at, created_at
ON unallocated_address_periods
BEGIN
    SELECT RAISE(ABORT, '未分配地址时期身份不可修改');
END;

CREATE TRIGGER validate_unallocated_period_transition
BEFORE UPDATE OF period_status, closed_at, claimed_by_user_id,
    claimed_address_id, claimed_address_binding_id
ON unallocated_address_periods
WHEN NOT (
    OLD.period_status = 'open'
    AND (
        (NEW.period_status = 'claimed'
            AND NEW.closed_at IS NOT NULL
            AND NEW.claimed_by_user_id IS NOT NULL
            AND NEW.claimed_address_id IS NOT NULL
            AND NEW.claimed_address_binding_id IS NOT NULL
            AND EXISTS (
                SELECT 1
                FROM email_addresses AS address
                JOIN address_bindings AS binding
                  ON binding.id = NEW.claimed_address_binding_id
                 AND binding.address_id = address.id
                 AND binding.owner_type = 'user'
                 AND binding.user_id = NEW.claimed_by_user_id
                 AND binding.address_role = 'alias'
                 AND binding.ended_at IS NULL
                WHERE address.id = NEW.claimed_address_id
                  AND address.domain_id = OLD.domain_id
                  AND address.canonical_address = OLD.canonical_address
                  AND address.retired_at IS NULL
            ))
        OR (NEW.period_status = 'closed'
            AND NEW.closed_at IS NOT NULL
            AND NEW.claimed_by_user_id IS NULL
            AND NEW.claimed_address_id IS NULL
            AND NEW.claimed_address_binding_id IS NULL)
    )
)
BEGIN
    SELECT RAISE(ABORT, '未分配地址时期只能从开放状态关闭或完成认领');
END;

CREATE TABLE unallocated_access_grants (
    domain_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    granted_by_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (domain_id, user_id),
    FOREIGN KEY (domain_id) REFERENCES mail_domains (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE INDEX unallocated_access_grants_user_index
    ON unallocated_access_grants (user_id, domain_id);

CREATE TRIGGER validate_unallocated_access_grant_insert
BEFORE INSERT ON unallocated_access_grants
WHEN NOT EXISTS (
    SELECT 1
    FROM system_instances AS system
    JOIN users AS administrator
      ON administrator.id = system.current_admin_user_id
     AND administrator.status = 'active'
    JOIN users AS target
      ON target.id = NEW.user_id
     AND target.status = 'active'
    JOIN mail_domains AS domain
      ON domain.id = NEW.domain_id
     AND domain.status = 'active'
     AND domain.catch_all_mode = 'unallocated'
    WHERE system.singleton_id = 1
      AND administrator.id = NEW.granted_by_user_id
)
BEGIN
    SELECT RAISE(ABORT, '未分配来信授权要求当前管理员、启用用户和全域收信域名');
END;

CREATE TRIGGER prevent_unallocated_access_grant_change
BEFORE UPDATE ON unallocated_access_grants
BEGIN
    SELECT RAISE(ABORT, '未分配来信授权不可修改，请撤销后重新建立');
END;

-- 现有 message_deliveries 保持为已分配地址投递，避免迁移时重建其十三张历史引用表。
-- 本表只保存未分配时期投递；应用层通过统一投递契约组合两者。
CREATE TABLE unallocated_message_deliveries (
    id TEXT PRIMARY KEY NOT NULL,
    message_id TEXT NOT NULL,
    unallocated_period_id TEXT NOT NULL,
    canonical_recipient_address TEXT COLLATE NOCASE NOT NULL,
    display_recipient_address TEXT NOT NULL,
    delivery_source TEXT NOT NULL CHECK (
        delivery_source IN ('external_receive', 'internal_delivery', 'migration')
    ),
    delivered_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (message_id, unallocated_period_id),
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT,
    FOREIGN KEY (unallocated_period_id) REFERENCES unallocated_address_periods (id) ON DELETE RESTRICT
);

CREATE INDEX unallocated_message_deliveries_period_index
    ON unallocated_message_deliveries (unallocated_period_id, delivered_at DESC, id DESC);

CREATE TRIGGER validate_unallocated_message_delivery_insert
BEFORE INSERT ON unallocated_message_deliveries
WHEN NOT EXISTS (
    SELECT 1
    FROM unallocated_address_periods AS period
    WHERE period.id = NEW.unallocated_period_id
      AND period.period_status = 'open'
      AND period.canonical_address = NEW.canonical_recipient_address
      AND period.display_address = NEW.display_recipient_address
)
BEGIN
    SELECT RAISE(ABORT, '未分配投递与开放地址时期不匹配');
END;

CREATE TRIGGER prevent_unallocated_message_delivery_change
BEFORE UPDATE ON unallocated_message_deliveries
BEGIN
    SELECT RAISE(ABORT, '未分配实际投递事实不可修改');
END;

CREATE TABLE mailbox_entry_unallocated_deliveries (
    mailbox_entry_id TEXT NOT NULL,
    unallocated_delivery_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (mailbox_entry_id, unallocated_delivery_id),
    FOREIGN KEY (mailbox_entry_id) REFERENCES mailbox_entries (id) ON DELETE CASCADE,
    FOREIGN KEY (unallocated_delivery_id)
        REFERENCES unallocated_message_deliveries (id) ON DELETE RESTRICT
);

CREATE TRIGGER validate_mailbox_entry_unallocated_delivery_insert
BEFORE INSERT ON mailbox_entry_unallocated_deliveries
WHEN NOT EXISTS (
    SELECT 1
    FROM mailbox_entries AS entry
    JOIN unallocated_message_deliveries AS delivery
      ON delivery.id = NEW.unallocated_delivery_id
     AND delivery.message_id = entry.message_id
    JOIN unallocated_address_periods AS period
      ON period.id = delivery.unallocated_period_id
     AND period.period_status = 'claimed'
     AND period.claimed_by_user_id = entry.user_id
    WHERE entry.id = NEW.mailbox_entry_id
      AND entry.mailbox_type = 'user'
      AND entry.entry_kind = 'received'
)
BEGIN
    SELECT RAISE(ABORT, '认领邮箱条目与未分配投递不匹配');
END;

CREATE TRIGGER prevent_mailbox_entry_unallocated_delivery_change
BEFORE UPDATE ON mailbox_entry_unallocated_deliveries
BEGIN
    SELECT RAISE(ABORT, '认领邮箱条目投递关系不可修改');
END;

CREATE TABLE receive_operation_unallocated_routes (
    id TEXT PRIMARY KEY NOT NULL,
    receive_operation_id TEXT NOT NULL UNIQUE,
    sequence_number INTEGER NOT NULL DEFAULT 0 CHECK (sequence_number = 0),
    canonical_recipient_address TEXT COLLATE NOCASE NOT NULL,
    display_recipient_address TEXT NOT NULL,
    domain_id TEXT NOT NULL,
    unallocated_period_id TEXT NOT NULL,
    route_status TEXT NOT NULL CHECK (route_status IN ('accepted', 'committed')),
    delivery_id TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    committed_at INTEGER,
    CHECK (
        (route_status = 'accepted' AND delivery_id IS NULL AND committed_at IS NULL)
        OR (route_status = 'committed' AND delivery_id IS NOT NULL AND committed_at IS NOT NULL)
    ),
    FOREIGN KEY (receive_operation_id) REFERENCES receive_operations (id) ON DELETE CASCADE,
    FOREIGN KEY (domain_id) REFERENCES mail_domains (id) ON DELETE RESTRICT,
    FOREIGN KEY (unallocated_period_id) REFERENCES unallocated_address_periods (id) ON DELETE RESTRICT,
    FOREIGN KEY (delivery_id) REFERENCES unallocated_message_deliveries (id) ON DELETE RESTRICT
);

CREATE INDEX receive_operation_unallocated_routes_status_index
    ON receive_operation_unallocated_routes (route_status, domain_id, created_at, id);

CREATE TRIGGER validate_receive_unallocated_route_insert
BEFORE INSERT ON receive_operation_unallocated_routes
WHEN EXISTS (
    SELECT 1 FROM receive_operation_routes
    WHERE receive_operation_id = NEW.receive_operation_id
)
OR NOT EXISTS (
    SELECT 1
    FROM receive_operations AS operation
    JOIN unallocated_address_periods AS period
      ON period.id = NEW.unallocated_period_id
     AND period.domain_id = NEW.domain_id
     AND period.canonical_address = NEW.canonical_recipient_address
     AND period.display_address = NEW.display_recipient_address
     AND period.period_status = 'open'
     AND period.started_at <= operation.accepted_at
    JOIN mail_domains AS domain
      ON domain.id = period.domain_id
     AND domain.status = 'active'
     AND domain.catch_all_mode = 'unallocated'
    WHERE operation.id = NEW.receive_operation_id
)
BEGIN
    SELECT RAISE(ABORT, '未分配冻结路由与接收时状态不匹配');
END;

CREATE TRIGGER prevent_assigned_route_for_unallocated_operation
BEFORE INSERT ON receive_operation_routes
WHEN EXISTS (
    SELECT 1 FROM receive_operation_unallocated_routes
    WHERE receive_operation_id = NEW.receive_operation_id
)
BEGIN
    SELECT RAISE(ABORT, '同一收信操作不能同时建立已分配和未分配路由');
END;

CREATE TRIGGER prevent_receive_unallocated_route_identity_change
BEFORE UPDATE OF receive_operation_id, sequence_number,
    canonical_recipient_address, display_recipient_address,
    domain_id, unallocated_period_id, created_at
ON receive_operation_unallocated_routes
BEGIN
    SELECT RAISE(ABORT, '未分配冻结路由不可修改');
END;

CREATE TRIGGER validate_receive_unallocated_route_commit
BEFORE UPDATE OF route_status, delivery_id, committed_at
ON receive_operation_unallocated_routes
WHEN NOT (
    OLD.route_status = 'accepted'
    AND NEW.route_status = 'committed'
    AND NEW.delivery_id IS NOT NULL
    AND NEW.committed_at IS NOT NULL
    AND EXISTS (
        SELECT 1
        FROM receive_operations AS operation
        JOIN unallocated_message_deliveries AS delivery
          ON delivery.id = NEW.delivery_id
         AND delivery.message_id = operation.message_id
         AND delivery.unallocated_period_id = OLD.unallocated_period_id
         AND delivery.canonical_recipient_address = OLD.canonical_recipient_address
        WHERE operation.id = OLD.receive_operation_id
          AND operation.message_id IS NOT NULL
    )
)
BEGIN
    SELECT RAISE(ABORT, '未分配冻结路由与最终投递不匹配');
END;

