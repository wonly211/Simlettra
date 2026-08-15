import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, "..", "..");
const migrationDirectory = path.join(repositoryRoot, "文档", "数据模型", "迁移草案");
const migrationFiles = [
  "0001-系统身份与地址基础.sql",
  "0002-邮件投递与邮箱视图.sql",
  "0003-草稿与发信状态.sql",
  "0004-对象收信与后台任务.sql",
  "0005-通知转发与外部连接.sql",
  "0006-删除配额审计备份与迁移.sql",
];

const database = new DatabaseSync(":memory:");
for (const fileName of migrationFiles) {
  database.exec(fs.readFileSync(path.join(migrationDirectory, fileName), "utf8"));
}

let assertionCount = 0;
const hash = (value) => Buffer.alloc(32, value);
const run = (sql, ...parameters) => database.prepare(sql).run(...parameters);
const get = (sql, ...parameters) => database.prepare(sql).get(...parameters);

function expect(name, condition) {
  if (!condition) {
    throw new Error(`验证失败：${name}`);
  }
  assertionCount += 1;
}

function expectReject(name, action) {
  let rejected = false;
  try {
    action();
  } catch {
    rejected = true;
  }
  expect(name, rejected);
}

function insertMessage({ id, originType, authoredBy = null, size = 100, at }) {
  run(
    `INSERT INTO messages (
        id, origin_type, authored_by_user_id, subject, accepted_at, sort_at,
        raw_size_bytes, attachment_count, has_attachments, created_at, updated_at
     ) VALUES (?, ?, ?, '', ?, ?, ?, 0, 0, ?, ?)`,
    id,
    originType,
    authoredBy,
    at,
    at,
    size,
    at,
    at,
  );
}

function insertReadyComposedMessage({ id, userId, at }) {
  insertMessage({ id, originType: "composed", authoredBy: userId, size: 100, at });
  run(
    `INSERT INTO object_registry (
        id, storage_mode, object_key, owner_kind, owner_reference, message_id,
        object_role, logical_part_key, sequence_number, generation,
        required_for_visibility, is_current, expected_size_bytes, expected_sha256,
        actual_size_bytes, actual_sha256, media_type, producer_version, object_status,
        stored_at, verified_at, activated_at, created_at, updated_at
     ) VALUES (
        ?, 'r2', ?, 'message', ?, ?, 'plain_body', '正文', 0, 1,
        1, 1, 4, ?, 4, ?, 'text/plain', '验证器-1', 'active',
        ?, ?, ?, ?, ?
     )`,
    `${id}-正文`,
    `对象/${id}/正文`,
    id,
    id,
    hash(10),
    hash(10),
    at + 1,
    at + 2,
    at + 3,
    at + 1,
    at + 3,
  );
  run(
    `INSERT INTO object_registry (
        id, storage_mode, object_key, owner_kind, owner_reference, message_id,
        object_role, logical_part_key, sequence_number, generation,
        required_for_visibility, is_current, expected_size_bytes, expected_sha256,
        actual_size_bytes, actual_sha256, media_type, producer_version, object_status,
        stored_at, verified_at, activated_at, created_at, updated_at
     ) VALUES (
        ?, 'r2', ?, 'message', ?, ?, 'final_mime', '完整邮件', 0, 1,
        1, 1, 100, ?, 100, ?, 'message/rfc822', '验证器-1', 'active',
        ?, ?, ?, ?, ?
     )`,
    `${id}-最终对象`,
    `对象/${id}/最终邮件`,
    id,
    id,
    hash(11),
    hash(11),
    at + 4,
    at + 5,
    at + 6,
    at + 4,
    at + 6,
  );
  run(
    `INSERT INTO message_integrity_states (
        message_id, source_completeness, integrity_status, object_set_version,
        ready_at, created_at, updated_at
     ) VALUES (?, 'final_mime', 'ready', 1, ?, ?, ?)`,
    id,
    at + 7,
    at + 7,
    at + 7,
  );
}

function insertInternalSend({ operationId, recipientId, messageId, deliveryId, sentEntryId, at }) {
  insertReadyComposedMessage({ id: messageId, userId: "用户-1", at });
  run(
    `INSERT INTO mailbox_entries (
        id, message_id, mailbox_type, user_id, entry_kind, base_location, occurred_at, created_at
     ) VALUES (?, ?, 'user', '用户-1', 'sent', 'sent', ?, ?)`,
    sentEntryId,
    messageId,
    at + 5,
    at + 5,
  );
  run(
    `INSERT INTO message_deliveries (
        id, message_id, target_type, address_binding_id,
        canonical_recipient_address, display_recipient_address,
        delivery_source, delivered_at, created_at
     ) VALUES (?, ?, 'assigned', '归属-1', 'user@example.com', 'user@example.com',
        'internal_delivery', ?, ?)`,
    deliveryId,
    messageId,
    at + 6,
    at + 6,
  );
  run(
    `INSERT INTO send_operations (
        id, operator_user_id, message_id, sent_mailbox_entry_id, sender_address_id,
        sender_address_binding_id, sent_mailbox_type, sent_user_id, compose_kind,
        recipient_count, internal_recipient_count, external_recipient_count,
        quota_recipient_units, payload_sha256, payload_size_bytes,
        effective_size_limit_bytes, workflow_status, accepted_at, created_at, updated_at,
        final_mime_object_id, payload_generator_version
     ) VALUES (
        ?, '用户-1', ?, ?, '地址-1', '归属-1', 'user', '用户-1', 'new',
        1, 1, 0, 1, ?, 100, 20000000, 'accepted', ?, ?, ?, ?, '验证器-1'
     )`,
    operationId,
    messageId,
    sentEntryId,
    hash(11),
    at + 7,
    at + 7,
    at + 7,
    `${messageId}-最终对象`,
  );
  run(
    `INSERT INTO send_recipients (
        id, send_operation_id, recipient_role, sequence_number, address_text,
        canonical_address, deduplication_key, route_channel, message_delivery_id,
        delivery_status, status_version, status_updated_at, created_at, updated_at
     ) VALUES (?, ?, 'to', 0, 'user@example.com', 'user@example.com', ?,
        'internal_assigned', ?, 'delivered', 1, ?, ?, ?)`,
    recipientId,
    operationId,
    hash(at % 255),
    deliveryId,
    at + 8,
    at + 8,
    at + 8,
  );
}

const sixthBatchTables = [
  "deletion_operations",
  "deletion_operation_blockers",
  "deletion_operation_steps",
  "quota_policies",
  "storage_usage_accounts",
  "storage_usage_entries",
  "storage_reservations",
  "platform_resource_thresholds",
  "platform_resource_snapshots",
  "platform_capacity_reservations",
  "domain_monthly_usage_periods",
  "domain_monthly_usage_reservations",
  "audit_events",
  "retention_policies",
  "history_cleanup_runs",
  "backup_runs",
  "backup_checkpoints",
  "backup_manifest_entries",
  "backup_required_key_versions",
  "restore_runs",
  "restore_checkpoints",
  "restore_checks",
  "export_runs",
  "export_items",
  "migration_runs",
  "migration_checkpoints",
  "migration_source_mappings",
  "migration_failures",
  "migration_reconciliations",
  "migrated_message_sources",
  "migration_user_password_results",
];

const tableCount = get(
  `SELECT count(*) AS count FROM sqlite_master
   WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
).count;
expect("六批累计建立 94 张表", tableCount === 94);
for (const tableName of sixthBatchTables) {
  expect(`第六批表已建立：${tableName}`, get(
    `SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?`,
    tableName,
  ).count === 1);
}

// 基础身份、域名、地址和组织。
run(`INSERT INTO users (id, status, display_name, invitation_policy, created_at, updated_at)
     VALUES ('用户-1', 'active', '用户一', 'manual', 100, 100)`);
run(`INSERT INTO users (id, status, display_name, invitation_policy, created_at, updated_at)
     VALUES ('用户-2', 'active', '用户二', 'manual', 100, 100)`);
run(`INSERT INTO mail_domains (
        id, canonical_name, display_name, status, catch_all_mode, created_at, updated_at
     ) VALUES ('域名-1', 'example.com', 'example.com', 'active', 'reject', 100, 100)`);
run(`INSERT INTO email_addresses (id, domain_id, display_address, canonical_address, created_at)
     VALUES ('地址-1', '域名-1', 'user@example.com', 'user@example.com', 100)`);
run(`INSERT INTO address_claims (canonical_address, address_id, status, created_at, updated_at)
     VALUES ('user@example.com', '地址-1', 'active', 100, 100)`);
run(`INSERT INTO address_bindings (
        id, address_id, owner_type, user_id, address_role, started_at
     ) VALUES ('归属-1', '地址-1', 'user', '用户-1', 'primary', 100)`);
run(`INSERT INTO organizations (
        id, name, creator_user_id, status, members_can_send, created_at, updated_at
     ) VALUES ('组织-1', '家庭', '用户-1', 'active', 0, 100, 100)`);
run(`INSERT INTO organization_memberships (id, organization_id, user_id, joined_at)
     VALUES ('成员-1', '组织-1', '用户-2', 100)`);

// 删除操作：阻塞、恢复期限、幂等步骤和最终对账。
run(`INSERT INTO deletion_operations (
        id, operation_kind, target_type, target_reference, requested_by_user_id,
        policy_version, is_recoverable, requested_at, recovery_due_at,
        operation_status, created_at, updated_at
     ) VALUES (
        '删除-1', 'organization_delete', 'organization', '组织-1', '用户-1',
        1, 1, 200, 604800200, 'blocked', 200, 200
     )`);
expectReject("同一目标不能同时存在第二个活动删除操作", () => run(
  `INSERT INTO deletion_operations (
      id, operation_kind, target_type, target_reference, requested_by_user_id,
      policy_version, is_recoverable, requested_at, recovery_due_at,
      operation_status, created_at, updated_at
   ) VALUES ('删除-重复', 'organization_delete', 'organization', '组织-1', '用户-1',
      1, 1, 201, 604800201, 'recovery_pending', 201, 201)`,
));
expectReject("可恢复删除必须具有有效恢复期限", () => run(
  `INSERT INTO deletion_operations (
      id, operation_kind, target_type, target_reference, requested_by_user_id,
      policy_version, is_recoverable, requested_at, operation_status, created_at, updated_at
   ) VALUES ('删除-无期限', 'user_delete', 'user', '用户-2', '用户-2',
      1, 1, 201, 'recovery_pending', 201, 201)`,
));
run(`INSERT INTO deletion_operation_blockers (
        id, deletion_operation_id, blocker_key, blocker_type, blocker_reference,
        blocker_status, created_at
     ) VALUES ('阻塞-1', '删除-1', '创建者转让', 'ownership_transfer', '组织-1', 'open', 202)`);
expectReject("存在开放阻塞项时不能开始删除", () => run(
  `UPDATE deletion_operations SET operation_status = 'ready', updated_at = 203 WHERE id = '删除-1'`,
));
run(`UPDATE deletion_operation_blockers
     SET blocker_status = 'resolved', resolution_code = '已确认删除', resolved_at = 204
     WHERE id = '阻塞-1'`);
for (const [id, key, sequence, kind] of [
  ["步骤-撤权", "撤销访问", 0, "revoke_access"],
  ["步骤-对象", "清理对象", 1, "objects"],
  ["步骤-对账", "最终对账", 2, "reconcile"],
]) {
  run(
    `INSERT INTO deletion_operation_steps (
        id, deletion_operation_id, step_key, sequence_number, step_kind,
        step_status, created_at, updated_at
     ) VALUES (?, '删除-1', ?, ?, ?, 'pending', 205, 205)`,
    id,
    key,
    sequence,
    kind,
  );
}
run(`UPDATE deletion_operations SET operation_status = 'running', updated_at = 206 WHERE id = '删除-1'`);
expectReject("删除步骤未完成时不能标记永久完成", () => run(
  `UPDATE deletion_operations
   SET operation_status = 'completed', completed_at = 207, updated_at = 207
   WHERE id = '删除-1'`,
));
run(`UPDATE deletion_operation_steps
     SET step_status = 'succeeded', attempt_count = 1, started_at = 207,
         completed_at = 208, updated_at = 208
     WHERE deletion_operation_id = '删除-1'`);
run(`UPDATE deletion_operations
     SET operation_status = 'completed', completed_at = 209, updated_at = 209
     WHERE id = '删除-1'`);
expect("必要步骤与对账完成后可以永久完成", get(
  `SELECT operation_status FROM deletion_operations WHERE id = '删除-1'`,
).operation_status === "completed");
expectReject("已成功删除步骤不能倒退", () => run(
  `UPDATE deletion_operation_steps SET step_status = 'pending' WHERE id = '步骤-对象'`,
));

// 逻辑存储配额：预留、超限、释放和提交。
run(`INSERT INTO quota_policies (
        id, quota_kind, scope_type, user_id, policy_version, limit_value,
        policy_status, effective_at, created_at, updated_at
     ) VALUES ('配额-用户存储', 'storage_bytes', 'user', '用户-1', 1, 1000,
        'active', 300, 300, 300)`);
expectReject("同一用户不能同时有两份启用存储配额", () => run(
  `INSERT INTO quota_policies (
      id, quota_kind, scope_type, user_id, policy_version, limit_value,
      policy_status, effective_at, created_at, updated_at
   ) VALUES ('配额-重复', 'storage_bytes', 'user', '用户-1', 2, 2000,
      'active', 301, 301, 301)`,
));
run(`INSERT INTO storage_usage_accounts (
        id, owner_type, user_id, committed_bytes, reserved_bytes, created_at, updated_at
     ) VALUES ('用量账户-1', 'user', '用户-1', 200, 0, 300, 300)`);
run(`INSERT INTO storage_reservations (
        id, storage_usage_account_id, quota_policy_id, operation_kind, operation_reference,
        reserved_bytes, limit_bytes_snapshot, reservation_key_digest,
        reservation_status, expires_at, created_at, updated_at
     ) VALUES ('容量预留-1', '用量账户-1', '配额-用户存储', 'receive', '收信-1',
        500, 1000, ?, 'reserved', 1000, 310, 310)`, hash(21));
expect("预留写入后账户保留容量增加", get(
  `SELECT reserved_bytes FROM storage_usage_accounts WHERE id = '用量账户-1'`,
).reserved_bytes === 500);
expectReject("并发预留不能越过逻辑存储配额", () => run(
  `INSERT INTO storage_reservations (
      id, storage_usage_account_id, quota_policy_id, operation_kind, operation_reference,
      reserved_bytes, limit_bytes_snapshot, reservation_key_digest,
      reservation_status, expires_at, created_at, updated_at
   ) VALUES ('容量预留-超限', '用量账户-1', '配额-用户存储', 'receive', '收信-2',
      400, 1000, ?, 'reserved', 1000, 311, 311)`, hash(22),
));
run(`UPDATE storage_reservations
     SET reservation_status = 'released', released_at = 312, updated_at = 312
     WHERE id = '容量预留-1'`);
expect("释放后账户保留容量归零", get(
  `SELECT reserved_bytes FROM storage_usage_accounts WHERE id = '用量账户-1'`,
).reserved_bytes === 0);
run(`INSERT INTO storage_reservations (
        id, storage_usage_account_id, quota_policy_id, operation_kind, operation_reference,
        reserved_bytes, limit_bytes_snapshot, reservation_key_digest,
        reservation_status, expires_at, created_at, updated_at
     ) VALUES ('容量预留-2', '用量账户-1', '配额-用户存储', 'draft_attachment', '草稿附件-1',
        700, 1000, ?, 'reserved', 1000, 313, 313)`, hash(23));
run(`UPDATE storage_reservations
     SET reservation_status = 'committed', committed_at = 314, updated_at = 314
     WHERE id = '容量预留-2'`);
expect("提交后容量从预留转为正式用量", (() => {
  const row = get(`SELECT committed_bytes, reserved_bytes FROM storage_usage_accounts WHERE id = '用量账户-1'`);
  return row.committed_bytes === 900 && row.reserved_bytes === 0;
})());
run(`INSERT INTO storage_usage_entries (
        id, storage_usage_account_id, storage_reservation_id, entry_kind,
        owner_reference, bytes_delta, idempotency_key_digest, committed_at, created_at
     ) VALUES ('用量账本-1', '用量账户-1', '容量预留-2', 'draft',
        '草稿附件-1', 700, ?, 314, 314)`, hash(24));
expectReject("逻辑用量账本不可改写", () => run(
  `UPDATE storage_usage_entries SET bytes_delta = 1 WHERE id = '用量账本-1'`,
));

// 平台免费额度：快照不可变、双重预留和保守停止。
run(`INSERT INTO platform_resource_thresholds (
        id, resource_kind, threshold_version, warning_ratio_bps, stop_ratio_bps,
        threshold_status, effective_at, created_at, updated_at
     ) VALUES ('阈值-R2', 'r2', 1, 7000, 8000, 'active', 400, 400, 400)`);
run(`INSERT INTO platform_resource_snapshots (
        id, resource_kind, scope_kind, scope_reference, free_limit_bytes,
        account_used_bytes, simlettra_used_bytes, remaining_bytes, item_count,
        data_source, fetch_status, observed_at, fetched_at, created_at
     ) VALUES ('快照-R2', 'r2', 'account', '账号-1', 1000,
        600, 500, 400, 5, 'cloudflare_api', 'success', 400, 401, 401)`);
expectReject("平台资源快照不可改写", () => run(
  `UPDATE platform_resource_snapshots SET account_used_bytes = 500 WHERE id = '快照-R2'`,
));
run(`INSERT INTO platform_capacity_reservations (
        id, platform_resource_snapshot_id, platform_resource_threshold_id,
        resource_kind, operation_kind, operation_reference, estimated_bytes,
        safety_margin_bytes, stop_limit_bytes_snapshot, reservation_key_digest,
        reservation_status, expires_at, created_at, updated_at
     ) VALUES ('平台预留-1', '快照-R2', '阈值-R2', 'r2', 'receive', '收信-1',
        100, 50, 800, ?, 'reserved', 1000, 402, 402)`, hash(31));
expectReject("平台预留与安全余量不能越过停止值", () => run(
  `INSERT INTO platform_capacity_reservations (
      id, platform_resource_snapshot_id, platform_resource_threshold_id,
      resource_kind, operation_kind, operation_reference, estimated_bytes,
      safety_margin_bytes, stop_limit_bytes_snapshot, reservation_key_digest,
      reservation_status, expires_at, created_at, updated_at
   ) VALUES ('平台预留-超限', '快照-R2', '阈值-R2', 'r2', 'receive', '收信-2',
      60, 0, 800, ?, 'reserved', 1000, 403, 403)`, hash(32),
));
run(`UPDATE platform_capacity_reservations
     SET reservation_status = 'committed_pending_snapshot', committed_at = 404, updated_at = 404
     WHERE id = '平台预留-1'`);
expectReject("已提交但尚未被新快照吸收的用量继续占用容量", () => run(
  `INSERT INTO platform_capacity_reservations (
      id, platform_resource_snapshot_id, platform_resource_threshold_id,
      resource_kind, operation_kind, operation_reference, estimated_bytes,
      safety_margin_bytes, stop_limit_bytes_snapshot, reservation_key_digest,
      reservation_status, expires_at, created_at, updated_at
   ) VALUES ('平台预留-仍超限', '快照-R2', '阈值-R2', 'r2', 'receive', '收信-3',
      60, 0, 800, ?, 'reserved', 1000, 405, 405)`, hash(33),
));
run(`UPDATE platform_capacity_reservations
     SET reservation_status = 'reconciled', reconciled_at = 406, updated_at = 406
     WHERE id = '平台预留-1'`);
run(`INSERT INTO platform_capacity_reservations (
        id, platform_resource_snapshot_id, platform_resource_threshold_id,
        resource_kind, operation_kind, operation_reference, estimated_bytes,
        safety_margin_bytes, stop_limit_bytes_snapshot, reservation_key_digest,
        reservation_status, expires_at, created_at, updated_at
     ) VALUES ('平台预留-2', '快照-R2', '阈值-R2', 'r2', 'receive', '收信-4',
        200, 0, 800, ?, 'reserved', 1000, 407, 407)`, hash(34));
expect("对账释放旧占用后可以在停止值内再次预留", get(
  `SELECT reservation_status FROM platform_capacity_reservations WHERE id = '平台预留-2'`,
).reservation_status === "reserved");
run(`INSERT INTO platform_resource_snapshots (
        id, resource_kind, scope_kind, scope_reference, free_limit_bytes,
        data_source, fetch_status, fetched_at, error_code, created_at
     ) VALUES ('快照-不可用', 'kv', 'account', '账号-1', 1000,
        'cloudflare_api', 'unavailable', 408, 'API_UNAVAILABLE', 408)`);
expectReject("不可用快照不能用于容量准入", () => run(
  `INSERT INTO platform_capacity_reservations (
      id, platform_resource_snapshot_id, platform_resource_threshold_id,
      resource_kind, operation_kind, operation_reference, estimated_bytes,
      safety_margin_bytes, stop_limit_bytes_snapshot, reservation_key_digest,
      reservation_status, expires_at, created_at, updated_at
   ) VALUES ('平台预留-不可用', '快照-不可用', '阈值-R2', 'kv', 'receive', '收信-5',
      1, 0, 800, ?, 'reserved', 1000, 409, 409)`, hash(35),
));

// 域名自然月配额：逐收件人预留、防重、结果未知和释放。
run(`INSERT INTO quota_policies (
        id, quota_kind, scope_type, mail_domain_id, policy_version, limit_value,
        policy_status, effective_at, created_at, updated_at
     ) VALUES ('配额-域名月度', 'domain_monthly_send_recipients', 'domain', '域名-1',
        1, 2, 'active', 500, 500, 500)`);
run(`INSERT INTO domain_monthly_usage_periods (
        id, mail_domain_id, period_start_at, period_end_at, timezone_name,
        quota_policy_id, quota_limit_snapshot, period_status, created_at, updated_at
     ) VALUES ('月份-1', '域名-1', 0, 2678400, 'Asia/Shanghai',
        '配额-域名月度', 2, 'open', 500, 500)`);
insertInternalSend({ operationId: "发送-1", recipientId: "收件人-1", messageId: "发信邮件-1", deliveryId: "投递-1", sentEntryId: "已发送-1", at: 510 });
insertInternalSend({ operationId: "发送-2", recipientId: "收件人-2", messageId: "发信邮件-2", deliveryId: "投递-2", sentEntryId: "已发送-2", at: 530 });
insertInternalSend({ operationId: "发送-3", recipientId: "收件人-3", messageId: "发信邮件-3", deliveryId: "投递-3", sentEntryId: "已发送-3", at: 550 });
run(`INSERT INTO domain_monthly_usage_reservations (
        id, domain_monthly_usage_period_id, send_recipient_id,
        usage_status, reserved_at, created_at, updated_at
     ) VALUES ('月度预留-1', '月份-1', '收件人-1', 'reserved', 520, 520, 520)`);
run(`INSERT INTO domain_monthly_usage_reservations (
        id, domain_monthly_usage_period_id, send_recipient_id,
        usage_status, reserved_at, created_at, updated_at
     ) VALUES ('月度预留-2', '月份-1', '收件人-2', 'reserved', 540, 540, 540)`);
expectReject("同一最终收件人重试不能重复占用月度额度", () => run(
  `INSERT INTO domain_monthly_usage_reservations (
      id, domain_monthly_usage_period_id, send_recipient_id,
      usage_status, reserved_at, created_at, updated_at
   ) VALUES ('月度预留-重复', '月份-1', '收件人-1', 'reserved', 541, 541, 541)`,
));
expectReject("月度配额已满时第三名收件人不能预留", () => run(
  `INSERT INTO domain_monthly_usage_reservations (
      id, domain_monthly_usage_period_id, send_recipient_id,
      usage_status, reserved_at, created_at, updated_at
   ) VALUES ('月度预留-3', '月份-1', '收件人-3', 'reserved', 560, 560, 560)`,
));
run(`UPDATE domain_monthly_usage_reservations
     SET usage_status = 'committed', committed_at = 561, updated_at = 561
     WHERE id = '月度预留-1'`);
run(`UPDATE domain_monthly_usage_reservations
     SET usage_status = 'unknown_held', unknown_at = 562, updated_at = 562
     WHERE id = '月度预留-2'`);
expect("已提交和结果未知分别占用月度额度", (() => {
  const row = get(`SELECT committed_units, reserved_units, unknown_held_units
                   FROM domain_monthly_usage_periods WHERE id = '月份-1'`);
  return row.committed_units === 1 && row.reserved_units === 0 && row.unknown_held_units === 1;
})());
run(`UPDATE domain_monthly_usage_reservations
     SET usage_status = 'released', released_at = 563, updated_at = 563
     WHERE id = '月度预留-2'`);
run(`INSERT INTO domain_monthly_usage_reservations (
        id, domain_monthly_usage_period_id, send_recipient_id,
        usage_status, reserved_at, created_at, updated_at
     ) VALUES ('月度预留-3', '月份-1', '收件人-3', 'reserved', 564, 564, 564)`);
expect("结果未知被明确释放后额度可以重新使用", get(
  `SELECT reserved_units FROM domain_monthly_usage_periods WHERE id = '月份-1'`,
).reserved_units === 1);

// 审计与历史保留。
run(`INSERT INTO audit_events (
        id, occurred_at, actor_type, actor_user_id, action_name,
        target_type, target_reference, outcome, request_trace_id, created_at
     ) VALUES ('审计-1', 600, 'user', '用户-1', '修改配额',
        'mail_domain', '域名-1', 'succeeded', '追踪-1', 600)`);
expectReject("审计事件不可改写", () => run(
  `UPDATE audit_events SET outcome = 'failed' WHERE id = '审计-1'`,
));
const auditColumns = database.prepare("PRAGMA table_info(audit_events)").all().map((row) => row.name);
expect("审计表不包含正文、密码、令牌或密钥字段", !auditColumns.some((name) =>
  ["body", "password", "token", "secret", "key"].some((word) => name.includes(word))));
run(`INSERT INTO retention_policies (
        id, record_kind, policy_version, retention_days, policy_status,
        effective_at, created_at, updated_at
     ) VALUES ('保留-审计', 'audit', 1, 180, 'active', 600, 600, 600)`);
expectReject("审计保留期限不能低于 30 天", () => run(
  `INSERT INTO retention_policies (
      id, record_kind, policy_version, retention_days, policy_status,
      effective_at, created_at, updated_at
   ) VALUES ('保留-过短', 'audit', 2, 10, 'retired', 601, 601, 601)`,
));
expectReject("历史清理结果数量不能超过扫描数量", () => run(
  `INSERT INTO history_cleanup_runs (
      id, retention_policy_id, cutoff_at, run_status,
      scanned_count, deleted_count, failed_count, created_at, updated_at
   ) VALUES ('清理-错误', '保留-审计', 500, 'running', 1, 2, 0, 602, 602)`,
));

// 备份、恢复和导出。
run(`INSERT INTO backup_runs (
        id, backup_format_version, migration_version, storage_mode,
        encryption_mode, encryption_format, kdf_name, backup_status,
        created_at, updated_at
     ) VALUES ('备份-1', 1, '0006', 'r2', 'authenticated', 'AES-256-GCM',
        'Argon2id', 'running', 700, 700)`);
run(`INSERT INTO backup_checkpoints (
        id, backup_run_id, source_kind, source_name, cursor_value,
        scanned_count, written_count, written_bytes, checkpoint_status,
        created_at, updated_at
     ) VALUES ('备份检查点-1', '备份-1', 'd1_table', 'users', '用户-1',
        2, 2, 200, 'completed', 701, 701)`);
expectReject("同一备份来源只能有一个检查点", () => run(
  `INSERT INTO backup_checkpoints (
      id, backup_run_id, source_kind, source_name, scanned_count,
      written_count, written_bytes, checkpoint_status, created_at, updated_at
   ) VALUES ('备份检查点-重复', '备份-1', 'd1_table', 'users', 2, 2, 200,
      'completed', 702, 702)`,
));
run(`INSERT INTO backup_manifest_entries (
        id, backup_run_id, entry_kind, logical_key, row_count,
        content_sha256, created_at
     ) VALUES ('备份清单-1', '备份-1', 'd1_table', 'users', 2, ?, 703)`, hash(41));
expectReject("备份清单不可改写", () => run(
  `UPDATE backup_manifest_entries SET row_count = 3 WHERE id = '备份清单-1'`,
));
run(`INSERT INTO backup_required_key_versions (
        backup_run_id, key_purpose, key_version, created_at
     ) VALUES ('备份-1', 'config_encryption', 1, 704)`);
const backupColumns = database.prepare("PRAGMA table_info(backup_runs)").all().map((row) => row.name);
expect("备份运行不保存本地路径或备份密码", !backupColumns.some((name) =>
  name.includes("path") || name.includes("password")));
run(`UPDATE backup_runs
     SET backup_status = 'succeeded', table_count = 1, object_count = 0,
         total_bytes = 200, manifest_sha256 = ?, completed_at = 705, updated_at = 705
     WHERE id = '备份-1'`, hash(42));
run(`INSERT INTO restore_runs (
        id, source_backup_reference, source_manifest_sha256, target_mode,
        maintenance_mode_enabled, restore_status, current_stage, created_at, updated_at
     ) VALUES ('恢复-1', '备份-1', ?, 'empty', 0, 'validating', 'manifest', 710, 710)`, hash(42));
for (const [index, kind] of [
  "manifest_hash",
  "table_counts",
  "object_hashes",
  "foreign_keys",
  "object_references",
].entries()) {
  run(
    `INSERT INTO restore_checks (
        id, restore_run_id, check_kind, check_status, checked_at, created_at, updated_at
     ) VALUES (?, '恢复-1', ?, 'passed', ?, 711, 711)`,
    `恢复检查-${index}`,
    kind,
    711 + index,
  );
}
expectReject("恢复检查未全部通过时不能显示成功", () => run(
  `UPDATE restore_runs
   SET restore_status = 'succeeded', current_stage = 'completed', completed_at = 720, updated_at = 720
   WHERE id = '恢复-1'`,
));
run(`INSERT INTO restore_checks (
        id, restore_run_id, check_kind, check_status, checked_at, created_at, updated_at
     ) VALUES ('恢复检查-搜索', '恢复-1', 'search_rebuild', 'passed', 721, 721, 721)`);
run(`UPDATE restore_runs
     SET restore_status = 'succeeded', current_stage = 'completed', completed_at = 722, updated_at = 722
     WHERE id = '恢复-1'`);
expect("六项恢复检查通过后可以成功", get(
  `SELECT restore_status FROM restore_runs WHERE id = '恢复-1'`,
).restore_status === "succeeded");

insertReadyComposedMessage({ id: "组织邮件-1", userId: "用户-1", at: 731 });
run(`INSERT INTO mailbox_entries (
        id, message_id, mailbox_type, organization_id, entry_kind, base_location, occurred_at, created_at
     ) VALUES ('组织邮箱条目-1', '组织邮件-1', 'organization', '组织-1', 'sent', 'sent', 740, 740)`);
run(`INSERT INTO export_runs (
        id, requested_by_user_id, scope_type, scope_digest, frozen_message_count,
        output_format, export_status, expires_at, created_at, updated_at
     ) VALUES ('导出-个人', '用户-1', 'personal', ?, 1, 'zip_eml', 'running', 1000, 732, 732)`, hash(51));
run(`INSERT INTO export_items (
        id, export_run_id, message_id, sequence_number, source_quality,
        item_status, created_at, updated_at
     ) VALUES ('导出项目-个人', '导出-个人', '发信邮件-1', 0,
        'original_mime', 'pending', 733, 733)`);
expectReject("普通组织成员不能发起组织导出", () => run(
  `INSERT INTO export_runs (
      id, requested_by_user_id, scope_type, organization_id, scope_digest,
      frozen_message_count, output_format, export_status, expires_at, created_at, updated_at
   ) VALUES ('导出-越权', '用户-2', 'organization', '组织-1', ?, 1,
      'zip_eml', 'running', 1000, 734, 734)`, hash(52),
));
run(`INSERT INTO export_runs (
        id, requested_by_user_id, scope_type, organization_id, scope_digest,
        frozen_message_count, output_format, export_status, expires_at, created_at, updated_at
     ) VALUES ('导出-组织', '用户-1', 'organization', '组织-1', ?, 1,
        'zip_eml', 'running', 1000, 735, 735)`, hash(53));
run(`INSERT INTO export_items (
        id, export_run_id, message_id, sequence_number, source_quality,
        item_status, created_at, updated_at
     ) VALUES ('导出项目-组织', '导出-组织', '组织邮件-1', 0,
        'original_mime', 'pending', 736, 736)`);
expectReject("组织导出不能混入个人邮箱邮件", () => run(
  `INSERT INTO export_items (
      id, export_run_id, message_id, sequence_number, source_quality,
      item_status, created_at, updated_at
   ) VALUES ('导出项目-越权', '导出-组织', '发信邮件-1', 1,
      'original_mime', 'pending', 737, 737)`,
));

// 迁移：演练前置、来源映射、失败、对账和完整性标记。
run(`INSERT INTO migration_runs (
        id, run_mode, source_system, source_version, source_reference_commit,
        source_snapshot_sha256, migration_rules_version, target_version,
        run_status, created_at, updated_at
     ) VALUES ('迁移演练-1', 'rehearsal', 'Simletter', '旧版-1',
        '9d016831ff2d862e38c08d9376a58327bc8933df', ?, 1, '新版本-1',
        'planned', 800, 800)`, hash(61));
run(`UPDATE migration_runs
     SET run_status = 'succeeded', started_at = 801, completed_at = 802, updated_at = 802
     WHERE id = '迁移演练-1'`);
expectReject("来源快照变化后不能复用旧演练", () => run(
  `INSERT INTO migration_runs (
      id, run_mode, source_system, source_version, source_reference_commit,
      source_snapshot_sha256, migration_rules_version, target_version,
      rehearsal_run_id, run_status, created_at, updated_at
   ) VALUES ('正式迁移-错误', 'formal', 'Simletter', '旧版-1',
      '9d016831ff2d862e38c08d9376a58327bc8933df', ?, 1, '新版本-1',
      '迁移演练-1', 'planned', 803, 803)`, hash(62),
));
run(`INSERT INTO migration_runs (
        id, run_mode, source_system, source_version, source_reference_commit,
        source_snapshot_sha256, migration_rules_version, target_version,
        rehearsal_run_id, run_status, created_at, updated_at
     ) VALUES ('正式迁移-1', 'formal', 'Simletter', '旧版-1',
        '9d016831ff2d862e38c08d9376a58327bc8933df', ?, 1, '新版本-1',
        '迁移演练-1', 'planned', 804, 804)`, hash(61));
run(`INSERT INTO migration_source_mappings (
        id, source_system, source_snapshot_sha256, source_entity_type,
        source_entity_id, source_content_sha256, target_entity_type,
        target_entity_reference, created_by_migration_run_id, created_at
     ) VALUES ('映射-1', 'Simletter', ?, 'user', 'old-user-1', ?,
        'user', '用户-1', '正式迁移-1', 805)`, hash(61), hash(63));
expectReject("同一来源对象不能建立第二份映射", () => run(
  `INSERT INTO migration_source_mappings (
      id, source_system, source_snapshot_sha256, source_entity_type,
      source_entity_id, source_content_sha256, target_entity_type,
      target_entity_reference, created_by_migration_run_id, created_at
   ) VALUES ('映射-重复', 'Simletter', ?, 'user', 'old-user-1', ?,
      'user', '用户-2', '正式迁移-1', 806)`, hash(61), hash(64),
));
expectReject("迁移来源映射不可改写", () => run(
  `UPDATE migration_source_mappings SET target_entity_reference = '用户-2' WHERE id = '映射-1'`,
));
expectReject("迁移检查点数量不能自相矛盾", () => run(
  `INSERT INTO migration_checkpoints (
      id, migration_run_id, entity_type, scanned_count, succeeded_count,
      skipped_count, failed_count, checkpoint_status, created_at, updated_at
   ) VALUES ('迁移检查点-错误', '正式迁移-1', 'user', 1, 2, 0, 0,
      'running', 807, 807)`,
));
run(`INSERT INTO migration_failures (
        id, migration_run_id, source_entity_type, source_entity_id,
        failure_code, failure_summary, failure_status, first_failed_at,
        created_at, updated_at
     ) VALUES ('迁移失败-1', '正式迁移-1', 'message', 'old-message-1',
        'MISSING_ATTACHMENT', '缺少附件对象', 'pending', 808, 808, 808)`);
run(`INSERT INTO migration_reconciliations (
        id, migration_run_id, entity_type, expected_count, scanned_count,
        succeeded_count, skipped_count, failed_count, reconciliation_status,
        created_at, updated_at
     ) VALUES ('迁移对账-1', '正式迁移-1', 'user', 1, 1, 1, 0, 0,
        'matched', 809, 809)`);
insertMessage({ id: "迁移邮件-1", originType: "migrated", at: 810 });
run(`INSERT INTO migrated_message_sources (
        message_id, migration_run_id, source_message_id, source_quality,
        reconstruction_version, created_at
     ) VALUES ('迁移邮件-1', '正式迁移-1', 'old-message-1',
        'structured_rebuilt', '重建器-1', 811)`);
expectReject("非迁移邮件不能伪装成迁移来源", () => run(
  `INSERT INTO migrated_message_sources (
      message_id, migration_run_id, source_message_id, source_quality,
      original_mime_sha256, created_at
   ) VALUES ('发信邮件-1', '正式迁移-1', 'old-message-2',
      'raw_mime', ?, 812)`, hash(65),
));
run(`INSERT INTO migration_user_password_results (
        migration_run_id, user_id, source_user_id, password_result,
        recorded_at
     ) VALUES ('正式迁移-1', '用户-1', 'old-user-1', 'reset_required', 813)`);
const passwordResultColumns = database.prepare("PRAGMA table_info(migration_user_password_results)").all().map((row) => row.name);
expect("密码迁移结果不保存明文或可逆密码", !passwordResultColumns.some((name) =>
  name.includes("plain") || name.includes("password_value") || name.includes("cipher")));

const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
expect("六批迁移草案外键检查为零", foreignKeyViolations.length === 0);

console.log(JSON.stringify({
  assertions: assertionCount,
  tables: tableCount,
  foreignKeyViolations: foreignKeyViolations.length,
}));
