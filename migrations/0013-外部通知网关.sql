PRAGMA foreign_keys = ON;

CREATE TABLE notification_subscriptions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
    channel_type TEXT NOT NULL CHECK (
        channel_type IN ('ntfy', 'gotify', 'wxpusher', 'telegram', 'bark')
    ),
    public_options_json TEXT NOT NULL CHECK (json_valid(public_options_json)),
    subscription_status TEXT NOT NULL CHECK (
        subscription_status IN ('active', 'paused', 'deleted')
    ),
    paused_at INTEGER,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (subscription_status = 'active' AND paused_at IS NULL AND deleted_at IS NULL)
        OR (subscription_status = 'paused' AND paused_at IS NOT NULL AND deleted_at IS NULL)
        OR (subscription_status = 'deleted' AND deleted_at IS NOT NULL)
    ),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX notification_subscriptions_user_index
    ON notification_subscriptions (user_id, subscription_status, created_at DESC, id DESC);

CREATE TABLE notification_subscription_scopes (
    id TEXT PRIMARY KEY NOT NULL,
    notification_subscription_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (
        scope_kind IN ('all_personal', 'personal_address', 'organization_address')
    ),
    email_address_id TEXT,
    created_at INTEGER NOT NULL,
    CHECK (
        (scope_kind = 'all_personal' AND email_address_id IS NULL)
        OR (scope_kind <> 'all_personal' AND email_address_id IS NOT NULL)
    ),
    FOREIGN KEY (notification_subscription_id)
        REFERENCES notification_subscriptions (id) ON DELETE CASCADE,
    FOREIGN KEY (email_address_id) REFERENCES email_addresses (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX notification_subscription_all_personal_unique
    ON notification_subscription_scopes (notification_subscription_id)
    WHERE scope_kind = 'all_personal';

CREATE UNIQUE INDEX notification_subscription_address_scope_unique
    ON notification_subscription_scopes (notification_subscription_id, email_address_id)
    WHERE email_address_id IS NOT NULL;

CREATE INDEX notification_subscription_scopes_address_index
    ON notification_subscription_scopes (email_address_id, scope_kind, notification_subscription_id);

CREATE TRIGGER validate_notification_subscription_scope_insert
BEFORE INSERT ON notification_subscription_scopes
WHEN NOT EXISTS (
    SELECT 1
    FROM notification_subscriptions AS subscription
    JOIN users AS user
      ON user.id = subscription.user_id
     AND user.status = 'active'
    LEFT JOIN address_bindings AS binding
      ON binding.address_id = NEW.email_address_id
     AND binding.ended_at IS NULL
    LEFT JOIN organizations AS organization
      ON organization.id = binding.organization_id
     AND organization.status = 'active'
    LEFT JOIN organization_memberships AS membership
      ON membership.organization_id = binding.organization_id
     AND membership.user_id = subscription.user_id
     AND membership.left_at IS NULL
    WHERE subscription.id = NEW.notification_subscription_id
      AND subscription.subscription_status <> 'deleted'
      AND (
          (NEW.scope_kind = 'all_personal' AND NEW.email_address_id IS NULL)
          OR (
              NEW.scope_kind = 'personal_address'
              AND binding.owner_type = 'user'
              AND binding.user_id = subscription.user_id
          )
          OR (
              NEW.scope_kind = 'organization_address'
              AND binding.owner_type = 'organization'
              AND organization.id IS NOT NULL
              AND membership.id IS NOT NULL
          )
      )
)
BEGIN
    SELECT RAISE(ABORT, '通知范围不是用户当前可查看的邮箱地址');
END;

CREATE TRIGGER prevent_notification_subscription_scope_change
BEFORE UPDATE ON notification_subscription_scopes
BEGIN
    SELECT RAISE(ABORT, '通知范围不可修改，请重新建立订阅');
END;

CREATE TABLE notification_subscription_secrets (
    notification_subscription_id TEXT PRIMARY KEY NOT NULL,
    credential_ciphertext BLOB NOT NULL CHECK (length(credential_ciphertext) > 0),
    credential_nonce BLOB NOT NULL CHECK (length(credential_nonce) = 12),
    credential_algorithm TEXT NOT NULL CHECK (credential_algorithm = 'AES-GCM-256'),
    credential_key_version INTEGER NOT NULL CHECK (credential_key_version >= 1),
    created_at INTEGER NOT NULL,
    FOREIGN KEY (notification_subscription_id)
        REFERENCES notification_subscriptions (id) ON DELETE CASCADE
);

CREATE TRIGGER prevent_notification_subscription_secret_change
BEFORE UPDATE ON notification_subscription_secrets
BEGIN
    SELECT RAISE(ABORT, '通知凭据不可原地修改，请重新建立订阅');
END;

CREATE TABLE notification_operations (
    id TEXT PRIMARY KEY NOT NULL,
    notification_subscription_id TEXT NOT NULL,
    message_delivery_id TEXT NOT NULL,
    payload_format_version INTEGER NOT NULL CHECK (payload_format_version >= 1),
    payload_object_set_version INTEGER NOT NULL CHECK (payload_object_set_version >= 1),
    payload_size_bytes INTEGER NOT NULL CHECK (payload_size_bytes >= 0),
    payload_sha256 BLOB NOT NULL CHECK (length(payload_sha256) = 32),
    operation_status TEXT NOT NULL CHECK (
        operation_status IN (
            'pending', 'submitting', 'submitted', 'failed', 'unknown', 'cancelled'
        )
    ),
    provider_reference TEXT,
    error_code TEXT,
    error_summary TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    UNIQUE (notification_subscription_id, message_delivery_id),
    CHECK (updated_at >= created_at),
    CHECK (
        (operation_status IN ('submitted', 'failed', 'unknown', 'cancelled')
            AND completed_at IS NOT NULL)
        OR (operation_status IN ('pending', 'submitting') AND completed_at IS NULL)
    ),
    FOREIGN KEY (notification_subscription_id)
        REFERENCES notification_subscriptions (id) ON DELETE RESTRICT,
    FOREIGN KEY (message_delivery_id) REFERENCES message_deliveries (id) ON DELETE RESTRICT
);

CREATE INDEX notification_operations_work_index
    ON notification_operations (operation_status, created_at, id);

CREATE INDEX notification_operations_subscription_index
    ON notification_operations (notification_subscription_id, created_at DESC, id DESC);

CREATE TRIGGER validate_notification_operation_insert
BEFORE INSERT ON notification_operations
WHEN NEW.operation_status <> 'pending'
  OR NEW.completed_at IS NOT NULL
  OR NOT EXISTS (
      SELECT 1
      FROM notification_subscriptions AS subscription
      JOIN users AS user
        ON user.id = subscription.user_id
       AND user.status = 'active'
      JOIN message_deliveries AS delivery
        ON delivery.id = NEW.message_delivery_id
      JOIN message_integrity_states AS integrity
        ON integrity.message_id = delivery.message_id
       AND integrity.integrity_status = 'ready'
       AND integrity.object_set_version = NEW.payload_object_set_version
      JOIN address_bindings AS binding
        ON binding.id = delivery.address_binding_id
       AND binding.ended_at IS NULL
      LEFT JOIN organizations AS organization
        ON organization.id = binding.organization_id
       AND organization.status = 'active'
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
                  (
                      scope.scope_kind = 'all_personal'
                      AND binding.owner_type = 'user'
                      AND binding.user_id = subscription.user_id
                  )
                  OR (
                      scope.scope_kind = 'personal_address'
                      AND binding.owner_type = 'user'
                      AND binding.user_id = subscription.user_id
                      AND scope.email_address_id = binding.address_id
                  )
                  OR (
                      scope.scope_kind = 'organization_address'
                      AND binding.owner_type = 'organization'
                      AND organization.id IS NOT NULL
                      AND membership.id IS NOT NULL
                      AND scope.email_address_id = binding.address_id
                  )
              )
        )
  )
BEGIN
    SELECT RAISE(ABORT, '通知操作必须在邮件完整且订阅范围仍有权限时建立');
END;

CREATE TRIGGER prevent_notification_operation_identity_change
BEFORE UPDATE OF
    notification_subscription_id, message_delivery_id, payload_format_version,
    payload_object_set_version, payload_size_bytes, payload_sha256, created_at
ON notification_operations
BEGIN
    SELECT RAISE(ABORT, '通知操作身份与内容摘要不可修改');
END;

CREATE TRIGGER validate_notification_operation_transition
BEFORE UPDATE OF operation_status ON notification_operations
WHEN NEW.operation_status <> OLD.operation_status
  AND NOT (
      (OLD.operation_status = 'pending'
          AND NEW.operation_status IN ('submitting', 'failed', 'cancelled'))
      OR (OLD.operation_status = 'submitting'
          AND NEW.operation_status IN (
              'pending', 'submitted', 'failed', 'unknown', 'cancelled'
          ))
  )
BEGIN
    SELECT RAISE(ABORT, '通知操作状态流转无效');
END;

CREATE TABLE notification_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    notification_operation_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    attempt_status TEXT NOT NULL CHECK (
        attempt_status IN ('prepared', 'submitting', 'submitted', 'failed', 'unknown')
    ),
    http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
    provider_reference TEXT,
    error_code TEXT,
    error_summary TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (notification_operation_id, attempt_number),
    CHECK (
        (attempt_status = 'prepared' AND started_at IS NULL AND completed_at IS NULL)
        OR (attempt_status = 'submitting' AND started_at IS NOT NULL AND completed_at IS NULL)
        OR (attempt_status IN ('submitted', 'failed', 'unknown')
            AND started_at IS NOT NULL AND completed_at IS NOT NULL)
    ),
    FOREIGN KEY (notification_operation_id)
        REFERENCES notification_operations (id) ON DELETE CASCADE
);

CREATE INDEX notification_attempts_operation_index
    ON notification_attempts (notification_operation_id, attempt_number DESC);

CREATE TRIGGER validate_notification_attempt_insert
BEFORE INSERT ON notification_attempts
WHEN NEW.attempt_status <> 'prepared'
  OR NEW.attempt_number <> COALESCE((
      SELECT MAX(attempt_number) + 1
      FROM notification_attempts
      WHERE notification_operation_id = NEW.notification_operation_id
  ), 1)
BEGIN
    SELECT RAISE(ABORT, '通知尝试必须按顺序从准备状态建立');
END;

CREATE TRIGGER prevent_notification_attempt_identity_change
BEFORE UPDATE OF notification_operation_id, attempt_number, created_at
ON notification_attempts
BEGIN
    SELECT RAISE(ABORT, '通知尝试身份不可修改');
END;

CREATE TRIGGER validate_notification_attempt_transition
BEFORE UPDATE OF attempt_status ON notification_attempts
WHEN NEW.attempt_status <> OLD.attempt_status
  AND NOT (
      (OLD.attempt_status = 'prepared' AND NEW.attempt_status = 'submitting')
      OR (OLD.attempt_status = 'submitting'
          AND NEW.attempt_status IN ('submitted', 'failed', 'unknown'))
  )
BEGIN
    SELECT RAISE(ABORT, '通知尝试状态流转无效');
END;
