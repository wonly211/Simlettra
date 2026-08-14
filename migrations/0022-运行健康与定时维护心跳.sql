-- 澄笺 | Simlettra 运行健康与定时维护心跳

PRAGMA foreign_keys = ON;

CREATE TABLE scheduled_maintenance_runs (
    id TEXT PRIMARY KEY NOT NULL,
    run_reference TEXT NOT NULL UNIQUE CHECK (length(run_reference) > 0),
    run_status TEXT NOT NULL CHECK (run_status IN ('running', 'succeeded', 'failed')),
    current_step TEXT NOT NULL CHECK (length(current_step) > 0),
    error_code TEXT,
    error_summary TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (updated_at >= created_at),
    CHECK (
        (run_status = 'running' AND completed_at IS NULL AND error_code IS NULL AND error_summary IS NULL)
        OR (run_status = 'succeeded' AND completed_at IS NOT NULL AND completed_at >= started_at
            AND error_code IS NULL AND error_summary IS NULL)
        OR (run_status = 'failed' AND completed_at IS NOT NULL AND completed_at >= started_at
            AND error_code IS NOT NULL AND error_summary IS NOT NULL)
    )
);

CREATE INDEX scheduled_maintenance_runs_latest_index
    ON scheduled_maintenance_runs (started_at DESC, id DESC);

CREATE INDEX scheduled_maintenance_runs_status_index
    ON scheduled_maintenance_runs (run_status, started_at DESC, id DESC);

CREATE TRIGGER prevent_scheduled_maintenance_identity_change
BEFORE UPDATE OF run_reference, started_at, created_at ON scheduled_maintenance_runs
BEGIN
    SELECT RAISE(ABORT, '定时维护运行身份不可修改');
END;

CREATE TRIGGER validate_scheduled_maintenance_transition
BEFORE UPDATE OF run_status ON scheduled_maintenance_runs
WHEN NEW.run_status <> OLD.run_status
  AND NOT (OLD.run_status = 'running' AND NEW.run_status IN ('succeeded', 'failed'))
BEGIN
    SELECT RAISE(ABORT, '定时维护运行状态不能倒退或重复结束');
END;
