CREATE TABLE audit_events (
    id TEXT PRIMARY KEY NOT NULL,
    occurred_at INTEGER NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'system', 'deleted_user')),
    actor_user_id TEXT,
    action_name TEXT NOT NULL CHECK (length(action_name) > 0),
    target_type TEXT NOT NULL CHECK (length(target_type) > 0),
    target_reference TEXT NOT NULL CHECK (length(target_reference) > 0),
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'denied')),
    reason_code TEXT,
    request_trace_id TEXT NOT NULL CHECK (length(request_trace_id) > 0),
    source_ip_text TEXT,
    browser_family TEXT,
    created_at INTEGER NOT NULL,
    CHECK (
        (actor_type = 'user' AND actor_user_id IS NOT NULL)
        OR actor_type IN ('system', 'deleted_user')
    ),
    FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX audit_events_time_index
    ON audit_events (occurred_at DESC, id DESC);

CREATE INDEX audit_events_target_index
    ON audit_events (target_type, target_reference, occurred_at DESC, id DESC);

CREATE TRIGGER prevent_audit_event_update
BEFORE UPDATE ON audit_events
BEGIN
    SELECT RAISE(ABORT, '审计事件不可修改');
END;
