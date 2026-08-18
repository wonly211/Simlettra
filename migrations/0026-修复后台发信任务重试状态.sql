PRAGMA foreign_keys = ON;

-- 旧实现可能在最后一次显式重试后仍把任务留在 retry_wait，
-- 但原状态触发器不允许应用服务把这种已耗尽任务收口为 needs_attention。
DROP TRIGGER IF EXISTS validate_background_task_transition;

CREATE TRIGGER validate_background_task_transition
BEFORE UPDATE OF task_status, attempt_count, lease_token ON background_tasks
WHEN (
    NEW.task_status <> OLD.task_status
    OR NEW.attempt_count <> OLD.attempt_count
    OR NEW.lease_token <> OLD.lease_token
)
AND NOT (
    (
        NEW.task_status = 'running'
        AND OLD.task_status IN ('pending', 'retry_wait')
        AND OLD.next_attempt_at IS NOT NULL
        AND OLD.next_attempt_at <= NEW.updated_at
        AND NEW.attempt_count = OLD.attempt_count + 1
        AND NEW.lease_token = OLD.lease_token + 1
        AND NEW.attempt_count <= OLD.max_attempts
    )
    OR (
        NEW.task_status = 'running'
        AND OLD.task_status = 'running'
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.lease_token = OLD.lease_token
        AND NEW.lease_owner_reference = OLD.lease_owner_reference
        AND NEW.lease_expires_at >= OLD.lease_expires_at
    )
    OR (
        NEW.task_status = 'running'
        AND OLD.task_status = 'running'
        AND OLD.lease_expires_at IS NOT NULL
        AND OLD.lease_expires_at <= NEW.updated_at
        AND NEW.attempt_count = OLD.attempt_count + 1
        AND NEW.lease_token = OLD.lease_token + 1
        AND NEW.attempt_count <= OLD.max_attempts
    )
    OR (
        OLD.task_status = 'running'
        AND NEW.task_status IN (
            'retry_wait', 'needs_attention', 'succeeded', 'cancelled'
        )
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.lease_token = OLD.lease_token
    )
    OR (
        OLD.task_status IN ('pending', 'retry_wait')
        AND NEW.task_status = 'cancelled'
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.lease_token = OLD.lease_token
    )
    OR (
        OLD.task_status IN ('pending', 'retry_wait')
        AND OLD.attempt_count >= OLD.max_attempts
        AND NEW.task_status = 'needs_attention'
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.lease_token = OLD.lease_token
    )
    OR (
        OLD.task_status = 'needs_attention'
        AND NEW.task_status IN ('pending', 'cancelled')
        AND NEW.attempt_count = OLD.attempt_count
        AND NEW.lease_token = OLD.lease_token
    )
)
BEGIN
    SELECT RAISE(ABORT, '后台任务状态、尝试次数或领取令牌无效');
END;

-- 升级时立即收口已经耗尽次数的历史任务；保留能够帮助定位问题的原错误码。
UPDATE background_tasks
SET task_status = 'needs_attention',
    next_attempt_at = NULL,
    lease_owner_reference = NULL,
    lease_expires_at = NULL,
    last_error_code = COALESCE(last_error_code, 'maximum_attempts_reached'),
    last_error_summary = COALESCE(
        last_error_summary,
        '后台任务已达到最大尝试次数，需要管理员检查'
    ),
    last_error_at = COALESCE(
        last_error_at,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000
    ),
    updated_at = MAX(
        updated_at,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000
    )
WHERE task_status IN ('pending', 'retry_wait')
  AND attempt_count >= max_attempts;
