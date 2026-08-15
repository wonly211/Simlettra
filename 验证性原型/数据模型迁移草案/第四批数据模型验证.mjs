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

function insertMessage({ id, originType, size = 0, attachmentCount = 0, authoredBy = null, at = 1000 }) {
  run(
    `INSERT INTO messages (
        id, origin_type, authored_by_user_id, subject, accepted_at, sort_at,
        raw_size_bytes, attachment_count, has_attachments, created_at, updated_at
     ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`,
    id,
    originType,
    authoredBy,
    at,
    at,
    size,
    attachmentCount,
    attachmentCount > 0 ? 1 : 0,
    at,
    at,
  );
}

function insertActiveMessageObject({
  id,
  messageId,
  role,
  partKey,
  generation = 1,
  sequence = 0,
  size = 0,
  hashValue = 1,
  mediaType,
  fileName = null,
  disposition = null,
  contentId = null,
  producer = "验证器-1",
  storageMode = "r2",
  at = 1100,
}) {
  run(
    `INSERT INTO object_registry (
        id, storage_mode, object_key, owner_kind, owner_reference, message_id,
        object_role, logical_part_key, sequence_number, generation,
        required_for_visibility, is_current, expected_size_bytes, expected_sha256,
        actual_size_bytes, actual_sha256, media_type, untrusted_file_name,
        content_disposition, content_id, producer_version, object_status,
        stored_at, verified_at, activated_at, created_at, updated_at
     ) VALUES (
        ?, ?, ?, 'message', ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'active', ?, ?, ?, ?, ?
     )`,
    id,
    storageMode,
    `对象/${messageId}/${role}/${partKey}/${generation}`,
    messageId,
    messageId,
    role,
    partKey,
    sequence,
    generation,
    size,
    hash(hashValue),
    size,
    hash(hashValue),
    mediaType,
    fileName,
    disposition,
    contentId,
    producer,
    at,
    at + 1,
    at + 2,
    at,
    at + 2,
  );
}

// 基础身份、域名、地址与未分配时期。
run(`INSERT INTO users (id, status, display_name, invitation_policy, created_at, updated_at)
     VALUES ('用户-1', 'active', '用户一', 'manual', 100, 100)`);
run(`INSERT INTO mail_domains (
        id, canonical_name, display_name, status, catch_all_mode, created_at, updated_at
     ) VALUES ('域名-1', 'example.com', 'example.com', 'active', 'unallocated', 100, 100)`);
run(`INSERT INTO email_addresses (id, domain_id, display_address, canonical_address, created_at)
     VALUES ('地址-1', '域名-1', 'user@example.com', 'user@example.com', 100)`);
run(`INSERT INTO address_claims (canonical_address, address_id, status, created_at, updated_at)
     VALUES ('user@example.com', '地址-1', 'active', 100, 100)`);
run(`INSERT INTO address_bindings (
        id, address_id, owner_type, user_id, address_role, started_at
     ) VALUES ('归属-1', '地址-1', 'user', '用户-1', 'primary', 100)`);
run(`INSERT INTO unallocated_address_periods (
        id, domain_id, canonical_address, display_address, status, started_at
     ) VALUES ('未分配-1', '域名-1', 'unknown@example.com', 'unknown@example.com', 'open', 100)`);

// 结构和迁移顺序。
const tableCount = get(
  `SELECT count(*) AS count FROM sqlite_master
   WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
).count;
expect("四批累计建立 46 张表", tableCount === 46);
for (const tableName of [
  "object_registry",
  "message_integrity_states",
  "receive_operations",
  "receive_operation_routes",
  "background_tasks",
  "background_task_attempts",
  "reconciliation_runs",
  "object_reconciliation_findings",
]) {
  expect(`第四批表已建立：${tableName}`, get(
    `SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?`,
    tableName,
  ).count === 1);
}
const sendColumns = database.prepare(`PRAGMA table_info(send_operations)`).all().map((row) => row.name);
expect("发送操作增加最终 MIME 对象", sendColumns.includes("final_mime_object_id"));
expect("发送操作增加负载生成器版本", sendColumns.includes("payload_generator_version"));
const dedupColumns = database.prepare(`PRAGMA table_info(message_deduplication_keys)`).all().map((row) => row.name);
expect("最终防重记录关联收信操作", dedupColumns.includes("receive_operation_id"));

// R2/KV 共用对象登记与状态机。
run(
  `INSERT INTO object_registry (
      id, storage_mode, object_key, owner_kind, owner_reference, object_role,
      logical_part_key, generation, expected_size_bytes, expected_sha256,
      media_type, producer_version, object_status, created_at, updated_at
   ) VALUES (
      '原始对象-1', 'kv', '对象/收信邮件-1/raw/1', 'message', '收信邮件-1',
      'raw_mime', 'raw', 1, 120, ?, 'message/rfc822', '收信入口-1',
      'write_intent', 200, 200
   )`,
  hash(1),
);
expectReject("对象不能跳过写入与校验直接激活", () => run(
  `UPDATE object_registry
   SET object_status = 'active', is_current = 1, activated_at = 201, updated_at = 201
   WHERE id = '原始对象-1'`,
));
run(`UPDATE object_registry
     SET object_status = 'stored', actual_size_bytes = 120, actual_sha256 = ?,
         stored_at = 201, updated_at = 201
     WHERE id = '原始对象-1'`, hash(1));
run(`UPDATE object_registry
     SET object_status = 'waiting_consistency', consistency_checked_at = 202, updated_at = 202
     WHERE id = '原始对象-1'`);
expect("KV 对象进入一致性等待", get(
  `SELECT object_status FROM object_registry WHERE id = '原始对象-1'`,
).object_status === "waiting_consistency");
expectReject("对象状态不能从一致性等待倒退到已写入", () => run(
  `UPDATE object_registry SET object_status = 'stored', updated_at = 203
   WHERE id = '原始对象-1'`,
));
run(`UPDATE object_registry
     SET object_status = 'verified', verified_at = 203, updated_at = 203
     WHERE id = '原始对象-1'`);
expect("KV 对象再次校验后可进入已验证", get(
  `SELECT object_status FROM object_registry WHERE id = '原始对象-1'`,
).object_status === "verified");

expectReject("普通附件必须保存不可信文件名和附件处置", () => {
  insertMessage({ id: "附件邮件-坏", originType: "received", at: 210 });
  insertActiveMessageObject({
    id: "附件对象-坏",
    messageId: "附件邮件-坏",
    role: "attachment",
    partKey: "1.2",
    mediaType: "application/octet-stream",
    at: 211,
  });
});
database.exec(`DELETE FROM messages WHERE id = '附件邮件-坏'`);

// 草稿附件对象必须与第三批附件快照一致。
run(`INSERT INTO drafts (
        id, owner_user_id, status, sender_address_id, compose_kind,
        current_revision_number, created_at, updated_at
     ) VALUES ('草稿-1', '用户-1', 'active', '地址-1', 'new', 1, 220, 220)`);
run(`INSERT INTO draft_attachments (
        id, draft_id, revision_number, sequence_number, untrusted_file_name,
        media_type, size_bytes, content_sha256, content_generation,
        integrity_checked_at, created_at
     ) VALUES (
        '草稿附件-1', '草稿-1', 1, 0, '文档.txt', 'text/plain', 3, ?, 1, 221, 221
     )`, hash(2));
run(`INSERT INTO object_registry (
        id, storage_mode, object_key, owner_kind, owner_reference,
        draft_attachment_id, object_role, logical_part_key, sequence_number,
        generation, required_for_visibility, is_current, expected_size_bytes,
        expected_sha256, actual_size_bytes, actual_sha256, media_type,
        untrusted_file_name, content_disposition, producer_version, object_status,
        stored_at, verified_at, activated_at, created_at, updated_at
     ) VALUES (
        '草稿对象-1', 'r2', '对象/草稿附件-1/1', 'draft_attachment', '草稿附件-1',
        '草稿附件-1', 'draft_attachment', '草稿附件-1', 0, 1, 0, 1, 3, ?, 3, ?,
        'text/plain', '文档.txt', 'attachment', '上传器-1', 'active',
        221, 222, 223, 221, 223
     )`, hash(2), hash(2));
expect("草稿附件对象与快照匹配", get(
  `SELECT count(*) AS count FROM object_registry WHERE draft_attachment_id = '草稿附件-1'`,
).count === 1);
expectReject("草稿附件对象不能使用错误代数", () => run(
  `INSERT INTO object_registry (
      id, storage_mode, object_key, owner_kind, owner_reference,
      draft_attachment_id, object_role, logical_part_key, sequence_number,
      generation, required_for_visibility, is_current, expected_size_bytes,
      expected_sha256, actual_size_bytes, actual_sha256, media_type,
      untrusted_file_name, content_disposition, producer_version, object_status,
      stored_at, verified_at, activated_at, created_at, updated_at
   ) VALUES (
      '草稿对象-坏', 'r2', '对象/草稿附件-1/2', 'draft_attachment', '草稿附件-1',
      '草稿附件-1', 'draft_attachment', '草稿附件-1', 0, 2, 0, 1, 3, ?, 3, ?,
      'text/plain', '文档.txt', 'attachment', '上传器-1', 'active',
      221, 222, 223, 221, 223
   )`, hash(2), hash(2)));

// 完整收信：有界防重、冻结路由、原子可见与搜索任务。
run(`INSERT INTO receive_operations (
        id, source_kind, source_event_reference, deduplication_kind,
        deduplication_key_digest, message_reference, raw_object_id,
        raw_size_bytes, raw_sha256, envelope_sender_text, operation_status,
        accepted_at, created_at, updated_at
     ) VALUES (
        '收信操作-1', 'cloudflare_email', '事件-1', 'provider_event', ?,
        '收信邮件-1', '原始对象-1', 120, ?, 'outside@test.example',
        'intent', 300, 300, 300
     )`, hash(10), hash(1));
run(`INSERT INTO receive_operation_routes (
        id, receive_operation_id, sequence_number, envelope_recipient_text,
        canonical_recipient_address, mail_domain_id, route_kind, address_id,
        address_binding_id, route_status, decided_at, created_at
     ) VALUES (
        '收信路由-1', '收信操作-1', 0, 'user@example.com', 'user@example.com',
        '域名-1', 'assigned', '地址-1', '归属-1', 'accepted', 300, 300
     )`);
expectReject("冻结路由必须匹配接受时的地址归属", () => run(
  `INSERT INTO receive_operation_routes (
      id, receive_operation_id, sequence_number, envelope_recipient_text,
      canonical_recipient_address, mail_domain_id, route_kind, address_id,
      address_binding_id, route_status, decided_at, created_at
   ) VALUES (
      '收信路由-坏', '收信操作-1', 1, 'other@example.com', 'other@example.com',
      '域名-1', 'assigned', '地址-1', '归属-1', 'accepted', 300, 300
   )`));
expectReject("冻结路由不可改指", () => run(
  `UPDATE receive_operation_routes SET canonical_recipient_address = 'changed@example.com'
   WHERE id = '收信路由-1'`,
));

run(`INSERT INTO receive_operations (
        id, source_kind, deduplication_kind, deduplication_key_digest,
        deduplication_window_started_at, deduplication_expires_at,
        message_reference, raw_size_bytes, raw_sha256, envelope_sender_text,
        operation_status, accepted_at, created_at, updated_at
     ) VALUES (
        '窗口操作-1', 'cloudflare_email', 'bounded_fingerprint', ?, 300, 400,
        '窗口邮件-1', 120, ?, 'outside@test.example', 'intent', 310, 310, 310
     )`, hash(11), hash(1));
run(`INSERT INTO receive_operations (
        id, source_kind, deduplication_kind, deduplication_key_digest,
        deduplication_window_started_at, deduplication_expires_at,
        message_reference, raw_size_bytes, raw_sha256, envelope_sender_text,
        operation_status, accepted_at, created_at, updated_at
     ) VALUES (
        '窗口操作-2', 'cloudflare_email', 'bounded_fingerprint', ?, 401, 501,
        '窗口邮件-2', 120, ?, 'outside@test.example', 'intent', 410, 410, 410
     )`, hash(12), hash(1));
expect("不同防重窗口允许相同原始内容", get(
  `SELECT count(*) AS count FROM receive_operations WHERE deduplication_kind = 'bounded_fingerprint'`,
).count === 2);
expectReject("同一来源防重摘要不能重复", () => run(
  `INSERT INTO receive_operations (
      id, source_kind, source_event_reference, deduplication_kind,
      deduplication_key_digest, message_reference, raw_size_bytes, raw_sha256,
      envelope_sender_text, operation_status, accepted_at, created_at, updated_at
   ) VALUES (
      '收信操作-重复', 'cloudflare_email', '事件-重复', 'provider_event', ?,
      '重复邮件', 120, ?, 'outside@test.example', 'intent', 311, 311, 311
   )`, hash(10), hash(1)));

run(`UPDATE receive_operations
     SET operation_status = 'raw_stored', updated_at = 320
     WHERE id = '收信操作-1'`);
run(`UPDATE receive_operations
     SET operation_status = 'parsing', parser_version = 'postal-mime-2.7.6', updated_at = 321
     WHERE id = '收信操作-1'`);
run(`UPDATE receive_operations
     SET operation_status = 'derived_stored', parsed_part_count = 2, updated_at = 322
     WHERE id = '收信操作-1'`);
expectReject("收信状态不能跳过最终提交", () => run(
  `UPDATE receive_operations
   SET operation_status = 'visible', visible_at = 323, completed_at = 323, updated_at = 323
   WHERE id = '收信操作-1'`,
));

insertMessage({ id: "收信邮件-1", originType: "received", size: 120, at: 330 });
run(`UPDATE object_registry
     SET message_id = '收信邮件-1', object_status = 'active', is_current = 1,
         activated_at = 331, updated_at = 331
     WHERE id = '原始对象-1'`);
insertActiveMessageObject({
  id: "正文对象-1",
  messageId: "收信邮件-1",
  role: "plain_body",
  partKey: "正文",
  size: 10,
  hashValue: 3,
  mediaType: "text/plain",
  at: 332,
});
expectReject("收信邮件不能登记最终发信 MIME", () => insertActiveMessageObject({
  id: "错误最终对象",
  messageId: "收信邮件-1",
  role: "final_mime",
  partKey: "最终",
  size: 120,
  hashValue: 4,
  mediaType: "message/rfc822",
  at: 333,
}));
expectReject("同一正文部件只能有一个当前代数", () => insertActiveMessageObject({
  id: "重复正文对象",
  messageId: "收信邮件-1",
  role: "plain_body",
  partKey: "正文",
  generation: 2,
  size: 10,
  hashValue: 5,
  mediaType: "text/plain",
  at: 334,
}));
run(`INSERT INTO message_integrity_states (
        message_id, source_completeness, integrity_status, object_set_version,
        ready_at, created_at, updated_at
     ) VALUES ('收信邮件-1', 'raw_mime', 'ready', 1, 335, 335, 335)`);
expect("收信邮件具备原始 MIME 和可显示正文", get(
  `SELECT integrity_status FROM message_integrity_states WHERE message_id = '收信邮件-1'`,
).integrity_status === "ready");

insertMessage({ id: "未就绪邮件", originType: "received", at: 336 });
expectReject("非就绪邮件不能建立邮箱条目", () => run(
  `INSERT INTO mailbox_entries (
      id, message_id, mailbox_type, user_id, entry_kind, base_location, occurred_at, created_at
   ) VALUES ('未就绪条目', '未就绪邮件', 'user', '用户-1', 'received', 'inbox', 336, 336)`,
));

run(`INSERT INTO message_deliveries (
        id, message_id, target_type, address_binding_id,
        canonical_recipient_address, display_recipient_address,
        delivery_source, delivered_at, created_at
     ) VALUES (
        '实际投递-1', '收信邮件-1', 'assigned', '归属-1',
        'user@example.com', 'user@example.com', 'external_receive', 337, 337
     )`);
run(`INSERT INTO mailbox_entries (
        id, message_id, mailbox_type, user_id, entry_kind, base_location,
        occurred_at, created_at
     ) VALUES (
        '邮箱条目-1', '收信邮件-1', 'user', '用户-1', 'received', 'inbox', 337, 337
     )`);
run(`INSERT INTO mailbox_entry_deliveries (mailbox_entry_id, delivery_id, created_at)
     VALUES ('邮箱条目-1', '实际投递-1', 337)`);
run(`UPDATE receive_operations
     SET message_id = '收信邮件-1', operation_status = 'committing', updated_at = 338
     WHERE id = '收信操作-1'`);
run(`INSERT INTO message_deduplication_keys (
        source_kind, key_digest, message_id, created_at, receive_operation_id
     ) VALUES ('cloudflare_email', ?, '收信邮件-1', 338, '收信操作-1')`, hash(10));
expectReject("冻结路由不能关联错误实际投递", () => run(
  `UPDATE receive_operation_routes
   SET route_status = 'committed', message_delivery_id = '不存在投递', committed_at = 338
   WHERE id = '收信路由-1'`,
));
run(`UPDATE receive_operation_routes
     SET route_status = 'committed', message_delivery_id = '实际投递-1', committed_at = 338
     WHERE id = '收信路由-1'`);
expectReject("没有搜索任务时收信不能标记可见", () => run(
  `UPDATE receive_operations
   SET operation_status = 'visible', visible_at = 339, completed_at = 339, updated_at = 339
   WHERE id = '收信操作-1'`,
));
run(`INSERT INTO background_tasks (
        id, task_type, target_type, target_reference, input_version,
        task_key_digest, task_status, max_attempts, next_attempt_at,
        created_at, updated_at
     ) VALUES (
        '搜索任务-1', 'index_message', 'message', '收信邮件-1', 1,
        ?, 'pending', 3, 339, 339, 339
     )`, hash(20));
run(`UPDATE receive_operations
     SET operation_status = 'visible', visible_at = 340, completed_at = 340, updated_at = 340
     WHERE id = '收信操作-1'`);
expect("完整收信操作最终可见", get(
  `SELECT operation_status FROM receive_operations WHERE id = '收信操作-1'`,
).operation_status === "visible");

// 解析确定性失败保留原始对象，并允许人工重新进入解析。
run(`INSERT INTO object_registry (
        id, storage_mode, object_key, owner_kind, owner_reference, object_role,
        logical_part_key, generation, expected_size_bytes, expected_sha256,
        actual_size_bytes, actual_sha256, media_type, producer_version,
        object_status, stored_at, verified_at, created_at, updated_at
     ) VALUES (
        '失败原始对象', 'r2', '对象/失败邮件/raw/1', 'message', '失败邮件',
        'raw_mime', 'raw', 1, 5, ?, 5, ?, 'message/rfc822', '收信入口-1',
        'verified', 350, 351, 350, 351
     )`, hash(6), hash(6));
run(`INSERT INTO receive_operations (
        id, source_kind, source_event_reference, deduplication_kind,
        deduplication_key_digest, message_reference, raw_object_id,
        raw_size_bytes, raw_sha256, envelope_sender_text, operation_status,
        accepted_at, created_at, updated_at
     ) VALUES (
        '失败收信操作', 'cloudflare_email', '失败事件', 'provider_event', ?,
        '失败邮件', '失败原始对象', 5, ?, '', 'intent', 350, 350, 350
     )`, hash(21), hash(6));
run(`UPDATE receive_operations SET operation_status = 'raw_stored', updated_at = 351
     WHERE id = '失败收信操作'`);
run(`UPDATE receive_operations SET operation_status = 'parsing', parser_version = 'postal-mime-2.7.6', updated_at = 352
     WHERE id = '失败收信操作'`);
run(`UPDATE receive_operations
     SET operation_status = 'parse_failed', error_code = 'MIME_DEPTH',
         error_summary = '结构超过限制', completed_at = 353, updated_at = 353
     WHERE id = '失败收信操作'`);
expect("确定性解析错误进入解析失败", get(
  `SELECT operation_status FROM receive_operations WHERE id = '失败收信操作'`,
).operation_status === "parse_failed");
run(`UPDATE receive_operations
     SET operation_status = 'parsing', completed_at = NULL, updated_at = 354
     WHERE id = '失败收信操作'`);
expect("人工处理后可以重新解析原始对象", get(
  `SELECT operation_status FROM receive_operations WHERE id = '失败收信操作'`,
).operation_status === "parsing");

// 未分配地址路由也冻结到对应时期。
run(`INSERT INTO receive_operations (
        id, source_kind, source_event_reference, deduplication_kind,
        deduplication_key_digest, message_reference, raw_size_bytes, raw_sha256,
        envelope_sender_text, operation_status, accepted_at, created_at, updated_at
     ) VALUES (
        '未分配操作', 'cloudflare_email', '未分配事件', 'provider_event', ?,
        '未分配邮件', 1, ?, '', 'intent', 360, 360, 360
     )`, hash(22), hash(7));
run(`INSERT INTO receive_operation_routes (
        id, receive_operation_id, sequence_number, envelope_recipient_text,
        canonical_recipient_address, mail_domain_id, route_kind,
        unallocated_period_id, route_status, decided_at, created_at
     ) VALUES (
        '未分配路由', '未分配操作', 0, 'unknown@example.com', 'unknown@example.com',
        '域名-1', 'unallocated', '未分配-1', 'accepted', 360, 360
     )`);
expect("未分配地址冻结到接受时时期", get(
  `SELECT route_kind FROM receive_operation_routes WHERE id = '未分配路由'`,
).route_kind === "unallocated");

// 损坏对象先隐藏，再用更高代数修复。
expectReject("就绪邮件不能直接停用当前对象", () => run(
  `UPDATE object_registry
   SET object_status = 'damaged', updated_at = 370
   WHERE id = '正文对象-1'`,
));
run(`UPDATE message_integrity_states
     SET integrity_status = 'repairing', object_set_version = 2,
         hidden_since = 370, updated_at = 370
     WHERE message_id = '收信邮件-1'`);
expect("修复中的邮件不满足普通可见查询", get(
  `SELECT count(*) AS count
   FROM mailbox_entries AS entry
   JOIN message_integrity_states AS integrity ON integrity.message_id = entry.message_id
   WHERE entry.id = '邮箱条目-1' AND integrity.integrity_status = 'ready'`,
).count === 0);
expectReject("完整性状态不变时不能漂移对象集合版本", () => run(
  `UPDATE message_integrity_states SET object_set_version = 3, updated_at = 371
   WHERE message_id = '收信邮件-1'`,
));
run(`UPDATE object_registry SET object_status = 'damaged', updated_at = 371
     WHERE id = '正文对象-1'`);
run(`UPDATE object_registry
     SET object_status = 'superseded', is_current = 0, superseded_at = 372, updated_at = 372
     WHERE id = '正文对象-1'`);
insertActiveMessageObject({
  id: "正文对象-2",
  messageId: "收信邮件-1",
  role: "plain_body",
  partKey: "正文",
  generation: 2,
  size: 11,
  hashValue: 8,
  mediaType: "text/plain",
  producer: "验证器-2",
  at: 373,
});
run(`UPDATE message_integrity_states
     SET integrity_status = 'ready', object_set_version = 3, ready_at = 376,
         hidden_since = NULL, damage_code = NULL, damage_summary = NULL, updated_at = 376
     WHERE message_id = '收信邮件-1'`);
expect("修复后切换到更高正文代数", get(
  `SELECT generation FROM object_registry
   WHERE message_id = '收信邮件-1' AND object_role = 'plain_body' AND is_current = 1`,
).generation === 2);
expectReject("邮件对象不能改指其他物理邮件", () => run(
  `UPDATE object_registry SET message_id = '未就绪邮件' WHERE id = '正文对象-2'`,
));

// 就绪状态必须有可显示正文，并检查附件数量。
insertMessage({ id: "只有原始邮件", originType: "received", at: 380 });
insertActiveMessageObject({
  id: "只有原始对象",
  messageId: "只有原始邮件",
  role: "raw_mime",
  partKey: "raw",
  size: 1,
  hashValue: 9,
  mediaType: "message/rfc822",
  at: 381,
});
expectReject("只有原始 MIME 没有正文不能就绪", () => run(
  `INSERT INTO message_integrity_states (
      message_id, source_completeness, integrity_status, object_set_version,
      ready_at, created_at, updated_at
   ) VALUES ('只有原始邮件', 'raw_mime', 'ready', 1, 384, 384, 384)`,
));

insertMessage({ id: "附件邮件", originType: "received", attachmentCount: 1, at: 390 });
insertActiveMessageObject({ id: "附件邮件原始", messageId: "附件邮件", role: "raw_mime", partKey: "raw", size: 1, hashValue: 10, mediaType: "message/rfc822", at: 391 });
insertActiveMessageObject({ id: "附件邮件正文", messageId: "附件邮件", role: "plain_body", partKey: "正文", size: 0, hashValue: 11, mediaType: "text/plain", at: 394 });
expectReject("附件数量与活动附件对象不一致不能就绪", () => run(
  `INSERT INTO message_integrity_states (
      message_id, source_completeness, integrity_status, object_set_version,
      ready_at, created_at, updated_at
   ) VALUES ('附件邮件', 'raw_mime', 'ready', 1, 397, 397, 397)`,
));
insertActiveMessageObject({
  id: "普通附件对象",
  messageId: "附件邮件",
  role: "attachment",
  partKey: "1.2",
  sequence: 0,
  size: 4,
  hashValue: 12,
  mediaType: "application/octet-stream",
  fileName: "附件.bin",
  disposition: "attachment",
  at: 398,
});
run(`INSERT INTO message_integrity_states (
        message_id, source_completeness, integrity_status, object_set_version,
        ready_at, created_at, updated_at
     ) VALUES ('附件邮件', 'raw_mime', 'ready', 1, 401, 401, 401)`);
expect("附件数量匹配后邮件可以就绪", get(
  `SELECT integrity_status FROM message_integrity_states WHERE message_id = '附件邮件'`,
).integrity_status === "ready");

// 结构化迁移邮件明确不伪装成原始 MIME。
insertMessage({ id: "迁移邮件", originType: "migrated", at: 410 });
insertActiveMessageObject({ id: "迁移正文", messageId: "迁移邮件", role: "plain_body", partKey: "正文", size: 2, hashValue: 13, mediaType: "text/plain", at: 411 });
run(`INSERT INTO message_integrity_states (
        message_id, source_completeness, integrity_status, object_set_version,
        ready_at, created_at, updated_at
     ) VALUES ('迁移邮件', 'structured_only', 'ready', 1, 414, 414, 414)`);
expect("迁移邮件可以明确标记只有结构化内容", get(
  `SELECT source_completeness FROM message_integrity_states WHERE message_id = '迁移邮件'`,
).source_completeness === "structured_only");

// 最终发信 MIME 与发送操作、供应商尝试使用同一快照。
insertMessage({ id: "发信邮件-1", originType: "composed", size: 80, authoredBy: "用户-1", at: 500 });
insertActiveMessageObject({ id: "发信正文-1", messageId: "发信邮件-1", role: "plain_body", partKey: "正文", size: 8, hashValue: 14, mediaType: "text/plain", at: 501 });
insertActiveMessageObject({ id: "最终对象-1", messageId: "发信邮件-1", role: "final_mime", partKey: "最终", size: 80, hashValue: 15, mediaType: "message/rfc822", producer: "MIME生成器-1", at: 504 });
run(`INSERT INTO message_integrity_states (
        message_id, source_completeness, integrity_status, object_set_version,
        ready_at, created_at, updated_at
     ) VALUES ('发信邮件-1', 'final_mime', 'ready', 1, 507, 507, 507)`);
run(`INSERT INTO mailbox_entries (
        id, message_id, mailbox_type, user_id, entry_kind, base_location,
        occurred_at, created_at
     ) VALUES ('已发送条目-1', '发信邮件-1', 'user', '用户-1', 'sent', 'sent', 508, 508)`);
run(`INSERT INTO send_operations (
        id, operator_user_id, message_id, sent_mailbox_entry_id,
        sender_address_id, sender_address_binding_id, sent_mailbox_type,
        sent_user_id, compose_kind, recipient_count, internal_recipient_count,
        external_recipient_count, quota_recipient_units, payload_sha256,
        payload_size_bytes, effective_size_limit_bytes, provider_type,
        provider_config_reference, provider_config_version,
        provider_size_limit_bytes, workflow_status, accepted_at, created_at,
        updated_at, final_mime_object_id, payload_generator_version
     ) VALUES (
        '发送操作-1', '用户-1', '发信邮件-1', '已发送条目-1',
        '地址-1', '归属-1', 'user', '用户-1', 'new', 1, 0, 1, 1, ?, 80,
        20000000, 'resend', '配置-1', 1, 40000000, 'accepted', 508, 508,
        508, '最终对象-1', 'MIME生成器-1'
     )`, hash(15));
expect("发送操作绑定最终 MIME 对象", get(
  `SELECT final_mime_object_id FROM send_operations WHERE id = '发送操作-1'`,
).final_mime_object_id === "最终对象-1");
expectReject("发送操作的最终 MIME 快照不可修改", () => run(
  `UPDATE send_operations SET final_mime_object_id = NULL WHERE id = '发送操作-1'`,
));
run(`INSERT INTO provider_submission_attempts (
        id, send_operation_id, attempt_number, attempt_type, attempt_status,
        provider_type, provider_config_reference, provider_config_version,
        payload_sha256, payload_size_bytes, created_at, updated_at
     ) VALUES (
        '供应商尝试-1', '发送操作-1', 1, 'initial', 'prepared', 'resend',
        '配置-1', 1, ?, 80, 509, 509
     )`, hash(15));
expect("供应商尝试沿用冻结负载摘要", get(
  `SELECT count(*) AS count FROM provider_submission_attempts
   WHERE send_operation_id = '发送操作-1' AND payload_size_bytes = 80`,
).count === 1);
expectReject("系统编写邮件不能登记原始收信 MIME", () => insertActiveMessageObject({
  id: "发信错误原始对象",
  messageId: "发信邮件-1",
  role: "raw_mime",
  partKey: "raw",
  size: 80,
  hashValue: 16,
  mediaType: "message/rfc822",
  at: 510,
}));

// 后台任务租约、领取令牌、尝试历史和人工处理。
run(`INSERT INTO background_tasks (
        id, task_type, target_type, target_reference, input_version,
        task_key_digest, task_status, max_attempts, next_attempt_at,
        created_at, updated_at
     ) VALUES (
        '租约任务', 'verify_object', 'object', '原始对象-1', 1, ?,
        'pending', 2, 600, 590, 590
     )`, hash(30));
expectReject("任务到期前不能领取", () => run(
  `UPDATE background_tasks
   SET task_status = 'running', attempt_count = 1, lease_owner_reference = '执行者-A',
       lease_token = 1, lease_expires_at = 700, next_attempt_at = NULL, updated_at = 599
   WHERE id = '租约任务'`,
));
run(`UPDATE background_tasks
     SET task_status = 'running', attempt_count = 1, lease_owner_reference = '执行者-A',
         lease_token = 1, lease_expires_at = 700, next_attempt_at = NULL, updated_at = 600
     WHERE id = '租约任务'`);
run(`INSERT INTO background_task_attempts (
        id, task_id, attempt_number, lease_token, worker_reference,
        attempt_status, started_at, created_at
     ) VALUES ('租约尝试-1', '租约任务', 1, 1, '执行者-A', 'running', 600, 600)`);
expectReject("租约到期前不能被其他执行者接管", () => run(
  `UPDATE background_tasks
   SET attempt_count = 2, lease_owner_reference = '执行者-B', lease_token = 2,
       lease_expires_at = 800, updated_at = 650
   WHERE id = '租约任务'`,
));
run(`UPDATE background_tasks
     SET attempt_count = 2, lease_owner_reference = '执行者-B', lease_token = 2,
         lease_expires_at = 800, updated_at = 700
     WHERE id = '租约任务'`);
expect("租约到期后使用更高领取令牌接管", get(
  `SELECT lease_token FROM background_tasks WHERE id = '租约任务'`,
).lease_token === 2);
expectReject("失去租约的旧尝试不能标记成功", () => run(
  `UPDATE background_task_attempts
   SET attempt_status = 'succeeded', retryable = 0, finished_at = 701
   WHERE id = '租约尝试-1'`,
));
run(`UPDATE background_task_attempts
     SET attempt_status = 'abandoned', retryable = 1, error_code = 'LEASE_LOST',
         error_summary = '租约已被新执行者接管', finished_at = 701
     WHERE id = '租约尝试-1'`);
expect("失去租约的尝试可以标记已放弃", get(
  `SELECT attempt_status FROM background_task_attempts WHERE id = '租约尝试-1'`,
).attempt_status === "abandoned");
run(`INSERT INTO background_task_attempts (
        id, task_id, attempt_number, lease_token, worker_reference,
        attempt_status, started_at, created_at
     ) VALUES ('租约尝试-2', '租约任务', 2, 2, '执行者-B', 'running', 700, 700)`);
run(`UPDATE background_task_attempts
     SET attempt_status = 'needs_attention', retryable = 0,
         error_code = 'OBJECT_DAMAGED', error_summary = '对象无法自动恢复', finished_at = 702
     WHERE id = '租约尝试-2'`);
run(`UPDATE background_tasks
     SET task_status = 'needs_attention', lease_owner_reference = NULL,
         lease_expires_at = NULL, last_error_code = 'OBJECT_DAMAGED',
         last_error_summary = '对象无法自动恢复', last_error_at = 702, updated_at = 702
     WHERE id = '租约任务' AND lease_token = 2`);
expect("确定性失败进入需要处理", get(
  `SELECT task_status FROM background_tasks WHERE id = '租约任务'`,
).task_status === "needs_attention");
run(`UPDATE background_tasks
     SET task_status = 'pending', next_attempt_at = 710, updated_at = 710
     WHERE id = '租约任务'`);
expectReject("尝试次数达到上限后不能再次领取", () => run(
  `UPDATE background_tasks
   SET task_status = 'running', attempt_count = 3, lease_owner_reference = '执行者-C',
       lease_token = 3, lease_expires_at = 900, next_attempt_at = NULL, updated_at = 710
   WHERE id = '租约任务'`,
));
expectReject("相同任务摘要不能建立第二个任务", () => run(
  `INSERT INTO background_tasks (
      id, task_type, target_type, target_reference, input_version,
      task_key_digest, task_status, max_attempts, next_attempt_at, created_at, updated_at
   ) VALUES (
      '重复任务', 'verify_object', 'object', '原始对象-1', 1, ?,
      'pending', 2, 710, 710, 710
   )`, hash(30)));

run(`INSERT INTO background_tasks (
        id, task_type, target_type, target_reference, input_version,
        task_key_digest, task_status, max_attempts, next_attempt_at,
        created_at, updated_at
     ) VALUES (
        '成功任务', 'reconcile', 'system', '系统', 1, ?,
        'pending', 1, 720, 720, 720
     )`, hash(31));
run(`UPDATE background_tasks
     SET task_status = 'running', attempt_count = 1, lease_owner_reference = '执行者-A',
         lease_token = 1, lease_expires_at = 800, next_attempt_at = NULL, updated_at = 720
     WHERE id = '成功任务'`);
run(`INSERT INTO background_task_attempts (
        id, task_id, attempt_number, lease_token, worker_reference,
        attempt_status, started_at, created_at
     ) VALUES ('成功尝试', '成功任务', 1, 1, '执行者-A', 'running', 720, 720)`);
run(`UPDATE background_task_attempts
     SET attempt_status = 'succeeded', retryable = 0, finished_at = 721
     WHERE id = '成功尝试'`);
run(`UPDATE background_tasks
     SET task_status = 'succeeded', lease_owner_reference = NULL,
         lease_expires_at = NULL, completed_at = 721, updated_at = 721
     WHERE id = '成功任务' AND lease_token = 1`);
expectReject("成功任务不能被 Queue 重放重新打开", () => run(
  `UPDATE background_tasks
   SET task_status = 'pending', next_attempt_at = 722, completed_at = NULL, updated_at = 722
   WHERE id = '成功任务'`,
));

// 分批对象对账与孤立对象保护。
run(`INSERT INTO reconciliation_runs (
        id, reconciliation_kind, storage_mode, batch_number, cursor_before,
        run_status, started_at, created_at, updated_at
     ) VALUES ('对账-1', 'object_inventory', 'r2', 1, NULL, 'running', 800, 800, 800)`);
run(`UPDATE reconciliation_runs
     SET run_status = 'succeeded', cursor_after = '游标-1', scanned_count = 10,
         finding_count = 1, completed_at = 801, updated_at = 801
     WHERE id = '对账-1'`);
run(`INSERT INTO reconciliation_runs (
        id, reconciliation_kind, storage_mode, batch_number, cursor_before,
        run_status, started_at, created_at, updated_at
     ) VALUES ('对账-2', 'object_inventory', 'r2', 2, '游标-1', 'running', 802, 802, 802)`);
run(`UPDATE reconciliation_runs
     SET run_status = 'succeeded', cursor_after = '游标-2', scanned_count = 10,
         finding_count = 1, completed_at = 803, updated_at = 803
     WHERE id = '对账-2'`);
run(`INSERT INTO object_reconciliation_findings (
        id, finding_kind, storage_mode, observed_object_key, finding_status,
        first_run_id, last_run_id, observation_count, first_observed_at,
        last_observed_at, protected_until, created_at, updated_at
     ) VALUES (
        '孤立发现', 'orphan', 'r2', '对象/孤立', 'open', '对账-1', '对账-1',
        1, 801, 801, 87201, 801, 801
     )`);
expectReject("同一孤立对象只能有一条开放发现", () => run(
  `INSERT INTO object_reconciliation_findings (
      id, finding_kind, storage_mode, observed_object_key, finding_status,
      first_run_id, last_run_id, observation_count, first_observed_at,
      last_observed_at, protected_until, created_at, updated_at
   ) VALUES (
      '重复孤立发现', 'orphan', 'r2', '对象/孤立', 'open', '对账-1', '对账-1',
      1, 801, 801, 87201, 801, 801
   )`));
expectReject("孤立对象只观察一次不能安排删除", () => run(
  `UPDATE object_reconciliation_findings
   SET finding_status = 'delete_scheduled', delete_scheduled_at = 87201, updated_at = 804
   WHERE id = '孤立发现'`,
));
run(`UPDATE object_reconciliation_findings
     SET observation_count = 2, last_run_id = '对账-2', last_observed_at = 803, updated_at = 803
     WHERE id = '孤立发现'`);
expectReject("孤立对象保护期结束前不能安排删除", () => run(
  `UPDATE object_reconciliation_findings
   SET finding_status = 'delete_scheduled', delete_scheduled_at = 87200, updated_at = 804
   WHERE id = '孤立发现'`,
));
run(`UPDATE object_reconciliation_findings
     SET finding_status = 'delete_scheduled', delete_scheduled_at = 87201, updated_at = 87201
     WHERE id = '孤立发现'`);
expect("两次独立观察且保护期结束后可安排删除", get(
  `SELECT finding_status FROM object_reconciliation_findings WHERE id = '孤立发现'`,
).finding_status === "delete_scheduled");
run(`INSERT INTO object_reconciliation_findings (
        id, finding_kind, object_registry_id, storage_mode, observed_object_key,
        finding_status, first_run_id, last_run_id, observation_count,
        first_observed_at, last_observed_at, created_at, updated_at
     ) VALUES (
        '缺失发现', 'missing', '原始对象-1', 'kv', '对象/收信邮件-1/raw/1',
        'open', '对账-2', '对账-2', 1, 803, 803, 803, 803
     )`);
expectReject("登记对象缺失不能套用孤立删除流程", () => run(
  `UPDATE object_reconciliation_findings
   SET finding_status = 'delete_scheduled', delete_scheduled_at = 90000, updated_at = 90000
   WHERE id = '缺失发现'`,
));

// 失败事务不得留下半封可见邮件。
let rolledBack = false;
try {
  database.exec("BEGIN");
  insertMessage({ id: "事务邮件", originType: "received", at: 900 });
  run(`INSERT INTO mailbox_entries (
        id, message_id, mailbox_type, user_id, entry_kind, base_location,
        occurred_at, created_at
       ) VALUES ('事务条目', '事务邮件', 'user', '用户-1', 'received', 'inbox', 900, 900)`);
  database.exec("COMMIT");
} catch {
  database.exec("ROLLBACK");
  rolledBack = true;
}
expect("最终事务失败后不留下物理邮件", rolledBack && get(
  `SELECT count(*) AS count FROM messages WHERE id = '事务邮件'`,
).count === 0);

const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
expect("四批数据外键检查为零", foreignKeyViolations.length === 0);

console.log(JSON.stringify({
  assertions: assertionCount,
  tables: tableCount,
  foreignKeyViolations: foreignKeyViolations.length,
}));
