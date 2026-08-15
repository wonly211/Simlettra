PRAGMA foreign_keys = ON;

-- 早期开发数据库的 0016 迁移尚未包含内部投递容量拒绝事实。
-- 当前正式数据库已经存在时，本迁移保持无副作用。
CREATE TABLE IF NOT EXISTS internal_delivery_rejections (
    id TEXT PRIMARY KEY NOT NULL,
    send_operation_id TEXT NOT NULL,
    recipient_role TEXT NOT NULL CHECK (recipient_role IN ('to', 'cc', 'bcc')),
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
    address_text TEXT NOT NULL CHECK (length(address_text) > 0),
    canonical_address TEXT NOT NULL CHECK (instr(canonical_address, '@') > 1),
    owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'organization')),
    user_id TEXT,
    organization_id TEXT,
    failure_code TEXT NOT NULL CHECK (failure_code = 'storage_quota_exceeded'),
    failure_detail TEXT NOT NULL CHECK (length(failure_detail) > 0),
    created_at INTEGER NOT NULL,
    UNIQUE (send_operation_id, recipient_role, sequence_number),
    CHECK (
        (owner_type = 'user' AND user_id IS NOT NULL AND organization_id IS NULL)
        OR (owner_type = 'organization' AND user_id IS NULL AND organization_id IS NOT NULL)
    ),
    FOREIGN KEY (send_operation_id) REFERENCES send_operations (id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS internal_delivery_rejections_operation_index
    ON internal_delivery_rejections (send_operation_id, recipient_role, sequence_number, id);

CREATE TRIGGER IF NOT EXISTS prevent_internal_delivery_rejection_change
BEFORE UPDATE ON internal_delivery_rejections
BEGIN
    SELECT RAISE(ABORT, '系统内投递拒绝事实不可修改');
END;
