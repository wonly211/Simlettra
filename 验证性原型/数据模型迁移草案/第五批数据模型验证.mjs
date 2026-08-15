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
];

const database = new DatabaseSync(":memory:");
for (const fileName of migrationFiles) {
  database.exec(fs.readFileSync(path.join(migrationDirectory, fileName), "utf8"));
}

let assertionCount = 0;
const hash = (value) => Buffer.alloc(32, value);
const nonce = (value) => Buffer.alloc(12, value);
const salt = (value) => Buffer.alloc(16, value);
const cipher = (value) => Buffer.from(`密文-${value}`, "utf8");
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

function insertMessage({ id, originType, authoredBy = null, size = 0, at = 1000 }) {
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

function insertActiveMessageObject({
  id,
  messageId,
  role,
  partKey,
  size,
  hashValue,
  mediaType,
  producer = "验证器-1",
  at,
}) {
  run(
    `INSERT INTO object_registry (
        id, storage_mode, object_key, owner_kind, owner_reference, message_id,
        object_role, logical_part_key, sequence_number, generation,
        required_for_visibility, is_current, expected_size_bytes, expected_sha256,
        actual_size_bytes, actual_sha256, media_type, producer_version, object_status,
        stored_at, verified_at, activated_at, created_at, updated_at
     ) VALUES (
        ?, 'r2', ?, 'message', ?, ?, ?, ?, 0, 1, 1, 1, ?, ?, ?, ?, ?, ?,
        'active', ?, ?, ?, ?, ?
     )`,
    id,
    `对象/${messageId}/${role}/${partKey}/1`,
    messageId,
    messageId,
    role,
    partKey,
    size,
    hash(hashValue),
    size,
    hash(hashValue),
    mediaType,
    producer,
    at,
    at + 1,
    at + 2,
    at,
    at + 2,
  );
}

function insertReadyMessage({ id, originType, authoredBy = null, payloadSize, finalHash, at }) {
  insertMessage({ id, originType, authoredBy, size: payloadSize, at });
  insertActiveMessageObject({
    id: `${id}-正文`,
    messageId: id,
    role: "plain_body",
    partKey: "正文",
    size: 4,
    hashValue: finalHash + 1,
    mediaType: "text/plain",
    at: at + 1,
  });
  const finalRole = originType === "received" ? "raw_mime" : "final_mime";
  insertActiveMessageObject({
    id: `${id}-最终对象`,
    messageId: id,
    role: finalRole,
    partKey: "完整邮件",
    size: payloadSize,
    hashValue: finalHash,
    mediaType: "message/rfc822",
    producer: "MIME生成器-1",
    at: at + 5,
  });
  run(
    `INSERT INTO message_integrity_states (
        message_id, source_completeness, integrity_status, object_set_version,
        ready_at, created_at, updated_at
     ) VALUES (?, ?, 'ready', 1, ?, ?, ?)`,
    id,
    originType === "received" ? "raw_mime" : "final_mime",
    at + 10,
    at + 10,
    at + 10,
  );
}

function insertProviderConfig({ id, key, version, type, value, at }) {
  run(
    `INSERT INTO outbound_provider_configs (
        id, configuration_key, configuration_version, provider_type,
        public_options_json, credential_ciphertext, credential_nonce,
        credential_algorithm, credential_key_version, credential_updated_at,
        configuration_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, '{}', ?, ?, 'AES-GCM-256', 1, ?, 'active', ?, ?)`,
    id,
    key,
    version,
    type,
    cipher(value),
    nonce(value),
    at,
    at,
    at,
  );
}

function insertRouteSnapshotEntry({ id, snapshotId, priority, configId, key, version, type, limit, digestValue, at }) {
  run(
    `INSERT INTO outbound_route_snapshot_entries (
        id, route_snapshot_id, priority_number, provider_config_id,
        configuration_key, configuration_version, provider_type,
        effective_size_limit_bytes, provider_options_digest, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    snapshotId,
    priority,
    configId,
    key,
    version,
    type,
    limit,
    hash(digestValue),
    at,
  );
}

const fifthBatchTables = [
  "outbound_provider_configs",
  "domain_outbound_routes",
  "domain_outbound_route_entries",
  "outbound_route_snapshots",
  "outbound_route_snapshot_entries",
  "outbound_submission_attempts",
  "outbound_submission_attempt_recipients",
  "outbound_provider_events",
  "send_recipient_route_progress",
  "notification_subscriptions",
  "notification_subscription_scopes",
  "notification_subscription_secrets",
  "notification_operations",
  "notification_attempts",
  "external_email_targets",
  "external_email_verifications",
  "mail_forwarding_rules",
  "mail_forwarding_rule_addresses",
  "mail_forward_operations",
  "mail_forward_attempts",
];

const tableCount = get(
  `SELECT count(*) AS count FROM sqlite_master
   WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
).count;
expect("五批累计建立 63 张表", tableCount === 63);
for (const tableName of fifthBatchTables) {
  expect(`第五批表已建立：${tableName}`, get(
    `SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?`,
    tableName,
  ).count === 1);
}

const sendColumns = database.prepare("PRAGMA table_info(send_operations)").all().map((row) => row.name);
expect("发送操作引用冻结路线", sendColumns.includes("outbound_route_snapshot_id"));
expect("发送操作不再冻结单一 Provider", !sendColumns.includes("provider_type"));
expect("发送操作仍引用最终 MIME 对象", sendColumns.includes("final_mime_object_id"));

// 基础身份、域名、个人地址和组织地址。
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
run(`INSERT INTO email_addresses (id, domain_id, display_address, canonical_address, created_at)
     VALUES ('组织地址-1', '域名-1', 'family@example.com', 'family@example.com', 100)`);
run(`INSERT INTO address_claims (canonical_address, address_id, status, created_at, updated_at)
     VALUES ('family@example.com', '组织地址-1', 'active', 100, 100)`);
run(`INSERT INTO address_bindings (
        id, address_id, owner_type, organization_id, address_role, started_at
     ) VALUES ('组织归属-1', '组织地址-1', 'organization', '组织-1', 'shared', 100)`);
run(`INSERT INTO organization_memberships (
        id, organization_id, user_id, joined_at
     ) VALUES ('成员关系-1', '组织-1', '用户-2', 100)`);

// 加密配置与域名路线。
insertProviderConfig({ id: "配置-Resend", key: "resend-main", version: 1, type: "resend", value: 2, at: 200 });
insertProviderConfig({ id: "配置-SMTP2GO", key: "smtp2go-backup", version: 1, type: "smtp2go", value: 3, at: 200 });
expectReject("拒绝 Cloudflare Email Sending Provider 类型", () => insertProviderConfig({
  id: "配置-CF",
  key: "cloudflare-main",
  version: 1,
  type: "cloudflare_email_sending",
  value: 1,
  at: 200,
}));

expectReject("服务凭据随机值必须为 12 字节", () => run(
  `INSERT INTO outbound_provider_configs (
      id, configuration_key, configuration_version, provider_type,
      public_options_json, credential_ciphertext, credential_nonce,
      credential_algorithm, credential_key_version, credential_updated_at,
      configuration_status, created_at, updated_at
   ) VALUES ('错误配置', 'bad', 1, 'resend', '{}', ?, ?, 'AES-GCM-256', 1, 201, 'active', 201, 201)`,
  cipher(9),
  Buffer.alloc(11, 9),
));
expectReject("服务配置版本不可重复", () => insertProviderConfig({
  id: "重复配置",
  key: "resend-main",
  version: 1,
  type: "resend",
  value: 4,
  at: 201,
}));
expectReject("服务凭据不可原地替换", () => run(
  `UPDATE outbound_provider_configs SET credential_ciphertext = ? WHERE id = '配置-Resend'`,
  cipher(8),
));

run(`INSERT INTO domain_outbound_routes (
        id, mail_domain_id, route_version, route_status, created_at, updated_at
     ) VALUES ('路线-1', '域名-1', 1, 'draft', 210, 210)`);
run(`INSERT INTO domain_outbound_route_entries (
         id, route_id, priority_number, provider_config_id, created_at
      ) VALUES ('路线条目-Resend', '路线-1', 0, '配置-Resend', 211)`);
run(`INSERT INTO domain_outbound_route_entries (
        id, route_id, priority_number, provider_config_id, created_at
     ) VALUES ('路线条目-SMTP2GO', '路线-1', 1, '配置-SMTP2GO', 211)`);
run(`UPDATE domain_outbound_routes
     SET route_status = 'active', activated_at = 212, updated_at = 212
     WHERE id = '路线-1'`);
expectReject("同一域名不能同时启用第二条路线", () => run(
  `INSERT INTO domain_outbound_routes (
      id, mail_domain_id, route_version, route_status, created_at, activated_at, updated_at
   ) VALUES ('路线-2', '域名-1', 2, 'active', 213, 213, 213)`,
));
expectReject("已启用路线不能改变优先顺序", () => run(
  `UPDATE domain_outbound_route_entries SET priority_number = 4 WHERE id = '路线条目-Resend'`,
));

// 10 MiB 邮件冻结两家服务，默认选择 Resend，SMTP2GO 作为备用。
const payloadSize = 10 * 1024 * 1024;
const resendLimit = 40 * 1024 * 1024;
const smtp2goLimit = 50 * 1024 * 1024;
run(`INSERT INTO outbound_route_snapshots (
        id, mail_domain_id, source_route_id, source_route_version, execution_kind,
        execution_reference, payload_sha256, payload_size_bytes, created_at
     ) VALUES ('发送快照-1', '域名-1', '路线-1', 1, 'send', '发送操作-1', ?, ?, 220)`,
  hash(10), payloadSize);
insertRouteSnapshotEntry({ id: "发送快照条目-Resend", snapshotId: "发送快照-1", priority: 0, configId: "配置-Resend", key: "resend-main", version: 1, type: "resend", limit: resendLimit, digestValue: 2, at: 220 });
insertRouteSnapshotEntry({ id: "发送快照条目-SMTP2GO", snapshotId: "发送快照-1", priority: 1, configId: "配置-SMTP2GO", key: "smtp2go-backup", version: 1, type: "smtp2go", limit: smtp2goLimit, digestValue: 3, at: 220 });

expect("10 MiB 默认选择 Resend", get(
  `SELECT provider_type FROM outbound_route_snapshot_entries
   WHERE route_snapshot_id = '发送快照-1'
     AND effective_size_limit_bytes >= ?
   ORDER BY priority_number LIMIT 1`, payloadSize,
).provider_type === "resend");
expect("没有兼容候选时预检查明确失败", get(
  `SELECT count(*) AS count FROM outbound_route_snapshot_entries
   WHERE route_snapshot_id = '发送快照-1' AND effective_size_limit_bytes >= ?`,
  60 * 1024 * 1024,
).count === 0);
expectReject("冻结后的 Provider 大小上限不可改写", () => run(
  `UPDATE outbound_route_snapshot_entries
   SET effective_size_limit_bytes = 1 WHERE id = '发送快照条目-Resend'`,
));

insertReadyMessage({
  id: "发信邮件-1",
  originType: "composed",
  authoredBy: "用户-1",
  payloadSize,
  finalHash: 10,
  at: 230,
});
run(`INSERT INTO mailbox_entries (
        id, message_id, mailbox_type, user_id, entry_kind, base_location, occurred_at, created_at
     ) VALUES ('已发送条目-1', '发信邮件-1', 'user', '用户-1', 'sent', 'sent', 240, 240)`);
run(`INSERT INTO send_operations (
        id, operator_user_id, message_id, sent_mailbox_entry_id, sender_address_id,
        sender_address_binding_id, sent_mailbox_type, sent_user_id, compose_kind,
        recipient_count, internal_recipient_count, external_recipient_count,
        quota_recipient_units, payload_sha256, payload_size_bytes,
        effective_size_limit_bytes, outbound_route_snapshot_id, workflow_status,
        accepted_at, created_at, updated_at, final_mime_object_id,
        payload_generator_version
     ) VALUES (
        '发送操作-1', '用户-1', '发信邮件-1', '已发送条目-1', '地址-1',
        '归属-1', 'user', '用户-1', 'new', 2, 0, 2, 2, ?, ?, 20971520,
        '发送快照-1', 'accepted', 240, 240, 240, '发信邮件-1-最终对象',
        'MIME生成器-1'
     )`, hash(10), payloadSize);

for (const [id, sequence, address, digestValue] of [
  ["外部收件人-1", 0, "one@outside.test", 31],
  ["外部收件人-2", 1, "two@outside.test", 32],
]) {
  run(`INSERT INTO send_recipients (
          id, send_operation_id, recipient_role, sequence_number, address_text,
          canonical_address, deduplication_key, route_channel, delivery_status,
          status_version, status_updated_at, created_at, updated_at
       ) VALUES (?, '发送操作-1', 'to', ?, ?, ?, ?, 'external', 'waiting', 1, 241, 241, 241)`,
    id, sequence, address, address, hash(digestValue));
}
run(`INSERT INTO send_recipient_route_progress (
        send_recipient_id, route_snapshot_id, next_priority_number, progress_status,
        created_at, updated_at
     ) VALUES ('外部收件人-1', '发送快照-1', 0, 'ready', 242, 242)`);
run(`INSERT INTO send_recipient_route_progress (
        send_recipient_id, route_snapshot_id, next_priority_number, progress_status,
        created_at, updated_at
     ) VALUES ('外部收件人-2', '发送快照-1', 0, 'ready', 242, 242)`);

run(`INSERT INTO outbound_submission_attempts (
        id, send_operation_id, route_snapshot_entry_id, attempt_number, attempt_status,
        payload_sha256, payload_size_bytes, created_at, updated_at
     ) VALUES ('外发尝试-1', '发送操作-1', '发送快照条目-Resend', 1, 'prepared', ?, ?, 243, 243)`,
  hash(10), payloadSize);
run(`INSERT INTO outbound_submission_attempt_recipients (
        outbound_submission_attempt_id, send_recipient_id, selection_kind, created_at
     ) VALUES ('外发尝试-1', '外部收件人-1', 'initial', 243)`);
run(`UPDATE outbound_submission_attempts
     SET attempt_status = 'submitting', started_at = 244, updated_at = 244
     WHERE id = '外发尝试-1'`);
run(`UPDATE outbound_submission_attempts
     SET attempt_status = 'not_accepted', completed_at = 245,
         error_code = 'TEMPORARY_REJECTION', updated_at = 245
     WHERE id = '外发尝试-1'`);
run(`UPDATE send_recipient_route_progress
     SET next_priority_number = 1, progress_status = 'not_accepted',
         last_switch_reason = 'temporary_rejection', updated_at = 246
     WHERE send_recipient_id = '外部收件人-1'`);
run(`INSERT INTO outbound_submission_attempts (
        id, send_operation_id, route_snapshot_entry_id, attempt_number, attempt_status,
        payload_sha256, payload_size_bytes, created_at, updated_at
     ) VALUES ('外发尝试-2', '发送操作-1', '发送快照条目-SMTP2GO', 2, 'prepared', ?, ?, 247, 247)`,
  hash(10), payloadSize);
run(`INSERT INTO outbound_submission_attempt_recipients (
        outbound_submission_attempt_id, send_recipient_id, selection_kind,
        fallback_reason, created_at
     ) VALUES ('外发尝试-2', '外部收件人-1', 'fallback', 'temporary_rejection', 247)`);
expect("明确未接受后可以登记备用服务尝试", get(
  `SELECT count(*) AS count FROM outbound_submission_attempt_recipients
   WHERE outbound_submission_attempt_id = '外发尝试-2'`,
).count === 1);

run(`INSERT INTO outbound_submission_attempts (
        id, send_operation_id, route_snapshot_entry_id, attempt_number, attempt_status,
        payload_sha256, payload_size_bytes, created_at, updated_at
     ) VALUES ('外发尝试-3', '发送操作-1', '发送快照条目-Resend', 3, 'prepared', ?, ?, 248, 248)`,
  hash(10), payloadSize);
run(`INSERT INTO outbound_submission_attempt_recipients (
        outbound_submission_attempt_id, send_recipient_id, selection_kind, created_at
     ) VALUES ('外发尝试-3', '外部收件人-2', 'initial', 248)`);
run(`UPDATE outbound_submission_attempts
     SET attempt_status = 'submitting', started_at = 249, updated_at = 249
     WHERE id = '外发尝试-3'`);
run(`UPDATE outbound_submission_attempts
     SET attempt_status = 'unknown', completed_at = 250,
         error_code = 'RESPONSE_LOST', updated_at = 250
     WHERE id = '外发尝试-3'`);
run(`UPDATE send_recipient_route_progress
     SET next_priority_number = 1, progress_status = 'unknown', updated_at = 251
     WHERE send_recipient_id = '外部收件人-2'`);
run(`INSERT INTO outbound_submission_attempts (
        id, send_operation_id, route_snapshot_entry_id, attempt_number, attempt_status,
        payload_sha256, payload_size_bytes, created_at, updated_at
     ) VALUES ('外发尝试-4', '发送操作-1', '发送快照条目-SMTP2GO', 4, 'prepared', ?, ?, 252, 252)`,
  hash(10), payloadSize);
expectReject("结果未知时不能登记备用切换", () => run(
  `INSERT INTO outbound_submission_attempt_recipients (
      outbound_submission_attempt_id, send_recipient_id, selection_kind,
      fallback_reason, created_at
   ) VALUES ('外发尝试-4', '外部收件人-2', 'fallback', 'service_unavailable', 252)`,
));
expectReject("结果未知的收件人不能自动恢复到可重试状态", () => run(
  `UPDATE send_recipient_route_progress
   SET progress_status = 'not_accepted', updated_at = 253
   WHERE send_recipient_id = '外部收件人-2'`,
));

run(`INSERT INTO outbound_provider_events (
        id, provider_type, provider_event_id, normalized_event_type,
        occurred_at, received_at, verified_at, raw_sha256,
        outbound_submission_attempt_id, send_recipient_id,
        match_status, processing_result, processed_at, created_at
     ) VALUES (
        '供应商事件-1', 'resend', 'event-1', 'delivered', 260, 261, 262, ?,
        '外发尝试-1', '外部收件人-1', 'matched', 'applied', 263, 261
     )`, hash(40));
expectReject("同一 Provider 事件不能重复保存", () => run(
  `INSERT INTO outbound_provider_events (
      id, provider_type, provider_event_id, normalized_event_type,
      occurred_at, received_at, verified_at, raw_sha256,
      match_status, processing_result, created_at
   ) VALUES ('重复事件', 'resend', 'event-1', 'other', 264, 264, 264, ?, 'pending', 'pending', 264)`,
  hash(41),
));

// 通知操作按“订阅 + 实际投递”防重，组织成员退出后不能建立新通知。
insertReadyMessage({ id: "来信邮件-1", originType: "received", payloadSize: 100, finalHash: 50, at: 300 });
run(`INSERT INTO message_deliveries (
        id, message_id, target_type, address_binding_id,
        canonical_recipient_address, display_recipient_address,
        delivery_source, delivered_at, created_at
     ) VALUES (
        '个人投递-1', '来信邮件-1', 'assigned', '归属-1',
        'user@example.com', 'user@example.com', 'external_receive', 312, 312
     )`);
run(`INSERT INTO message_deliveries (
        id, message_id, target_type, address_binding_id,
        canonical_recipient_address, display_recipient_address,
        delivery_source, delivered_at, created_at
     ) VALUES (
        '组织投递-1', '来信邮件-1', 'assigned', '组织归属-1',
        'family@example.com', 'family@example.com', 'external_receive', 312, 312
     )`);
run(`INSERT INTO notification_subscriptions (
        id, user_id, channel_type, public_options_json,
        subscription_status, created_at, updated_at
     ) VALUES ('通知订阅-1', '用户-1', 'ntfy', '{}', 'active', 313, 313)`);
run(`INSERT INTO notification_subscription_scopes (
        id, notification_subscription_id, scope_kind, email_address_id, created_at
     ) VALUES ('通知范围-1', '通知订阅-1', 'personal_address', '地址-1', 313)`);
run(`INSERT INTO notification_subscription_secrets (
        notification_subscription_id, credential_ciphertext, credential_nonce,
        credential_algorithm, credential_key_version, created_at, updated_at
     ) VALUES ('通知订阅-1', ?, ?, 'AES-GCM-256', 1, 313, 313)`, cipher(6), nonce(6));
run(`INSERT INTO notification_operations (
        id, notification_subscription_id, message_delivery_id,
        payload_object_set_version, payload_size_bytes, payload_sha256,
        operation_status, created_at, updated_at
     ) VALUES ('通知操作-1', '通知订阅-1', '个人投递-1', 1, 100, ?, 'pending', 314, 314)`, hash(50));
expectReject("同一实际投递与订阅只建立一个通知操作", () => run(
  `INSERT INTO notification_operations (
      id, notification_subscription_id, message_delivery_id,
      payload_object_set_version, payload_size_bytes, payload_sha256,
      operation_status, created_at, updated_at
   ) VALUES ('重复通知操作', '通知订阅-1', '个人投递-1', 1, 100, ?, 'pending', 315, 315)`,
  hash(50),
));
const notificationColumns = database.prepare("PRAGMA table_info(notification_operations)").all().map((row) => row.name);
expect("通知操作不复制邮件主题", !notificationColumns.includes("subject"));
expect("通知操作不复制邮件正文", !notificationColumns.includes("body") && !notificationColumns.includes("html_body"));

run(`INSERT INTO notification_subscriptions (
        id, user_id, channel_type, public_options_json,
        subscription_status, created_at, updated_at
     ) VALUES ('组织通知订阅', '用户-2', 'bark', '{}', 'active', 316, 316)`);
run(`INSERT INTO notification_subscription_scopes (
        id, notification_subscription_id, scope_kind, email_address_id, created_at
     ) VALUES ('组织通知范围', '组织通知订阅', 'organization_address', '组织地址-1', 316)`);
run(`UPDATE organization_memberships
     SET left_at = 317, left_reason = 'self_left'
     WHERE id = '成员关系-1'`);
expectReject("退出组织后不能建立新的组织邮件通知", () => run(
  `INSERT INTO notification_operations (
      id, notification_subscription_id, message_delivery_id,
      payload_object_set_version, payload_size_bytes, payload_sha256,
      operation_status, created_at, updated_at
   ) VALUES ('越权通知操作', '组织通知订阅', '组织投递-1', 1, 100, ?, 'pending', 318, 318)`,
  hash(50),
));

// 外部邮箱验证码只保存摘要，并且验证记录只能完成一次。
run(`INSERT INTO external_email_targets (
        id, user_id, display_email_address, canonical_email_address,
        target_status, created_at, updated_at
     ) VALUES ('外部目标-1', '用户-1', 'backup@outside.test', 'backup@outside.test', 'pending', 330, 330)`);
run(`INSERT INTO outbound_route_snapshots (
        id, mail_domain_id, source_route_id, source_route_version, execution_kind,
        execution_reference, payload_sha256, payload_size_bytes, created_at
     ) VALUES ('验证快照-1', '域名-1', '路线-1', 1, 'external_email_verification',
        '邮箱验证-1', ?, 500, 331)`, hash(60));
insertRouteSnapshotEntry({ id: "验证快照条目-1", snapshotId: "验证快照-1", priority: 0, configId: "配置-Resend", key: "resend-main", version: 1, type: "resend", limit: resendLimit, digestValue: 2, at: 331 });
run(`INSERT INTO external_email_verifications (
        id, external_email_target_id, verification_code_hash, verification_code_salt,
        expires_at, max_failure_count, failure_count, verification_status,
        outbound_route_snapshot_id, created_at, updated_at
     ) VALUES ('邮箱验证-1', '外部目标-1', ?, ?, 500, 5, 0, 'pending_delivery',
        '验证快照-1', 332, 332)`, hash(61), salt(61));
const verificationColumns = database.prepare("PRAGMA table_info(external_email_verifications)").all().map((row) => row.name);
expect("外部邮箱验证码只保存哈希字段", verificationColumns.includes("verification_code_hash") && !verificationColumns.includes("verification_code"));
expectReject("同一用户不能重复建立相同当前外部目标", () => run(
  `INSERT INTO external_email_targets (
      id, user_id, display_email_address, canonical_email_address,
      target_status, created_at, updated_at
   ) VALUES ('重复目标', '用户-1', 'backup@outside.test', 'backup@outside.test', 'pending', 333, 333)`,
));
run(`UPDATE external_email_verifications
     SET verification_status = 'pending_input', delivered_at = 334, updated_at = 334
     WHERE id = '邮箱验证-1'`);
run(`UPDATE external_email_verifications
     SET verification_status = 'verified', verified_at = 335, updated_at = 335
     WHERE id = '邮箱验证-1'`);
expectReject("已经成功的验证码不能重新使用", () => run(
  `UPDATE external_email_verifications
   SET verification_status = 'pending_input', verified_at = NULL, updated_at = 336
   WHERE id = '邮箱验证-1'`,
));
run(`UPDATE external_email_targets
     SET target_status = 'verified', verified_at = 335, updated_at = 335
     WHERE id = '外部目标-1'`);

// 自动转发只接受个人地址，并按来源投递、规则版本和目标防重。
run(`INSERT INTO mail_forwarding_rules (
        id, user_id, external_email_target_id, rule_version,
        scope_kind, rule_status, created_at, updated_at
     ) VALUES ('转发规则-1', '用户-1', '外部目标-1', 1, 'all_personal', 'active', 340, 340)`);
run(`INSERT INTO outbound_route_snapshots (
        id, mail_domain_id, source_route_id, source_route_version, execution_kind,
        execution_reference, payload_sha256, payload_size_bytes, created_at
     ) VALUES ('转发快照-1', '域名-1', '路线-1', 1, 'forward',
        '转发操作-1', ?, 100, 341)`, hash(70));
insertRouteSnapshotEntry({ id: "转发快照条目-1", snapshotId: "转发快照-1", priority: 0, configId: "配置-Resend", key: "resend-main", version: 1, type: "resend", limit: resendLimit, digestValue: 2, at: 341 });
run(`INSERT INTO mail_forward_operations (
        id, source_message_id, message_delivery_id, mail_forwarding_rule_id,
        rule_version, external_email_target_id, target_canonical_email_address,
        payload_sha256, payload_size_bytes, forwarding_hop_count,
        source_marked_by_simlettra, outbound_route_snapshot_id, operation_status,
        created_at, updated_at
     ) VALUES (
        '转发操作-1', '来信邮件-1', '个人投递-1', '转发规则-1', 1,
        '外部目标-1', 'backup@outside.test', ?, 100, 0, 0,
        '转发快照-1', 'pending', 342, 342
     )`, hash(70));
expectReject("重复任务不能建立第二个转发操作", () => run(
  `INSERT INTO mail_forward_operations (
      id, source_message_id, message_delivery_id, mail_forwarding_rule_id,
      rule_version, external_email_target_id, target_canonical_email_address,
      payload_sha256, payload_size_bytes, forwarding_hop_count,
      source_marked_by_simlettra, outbound_route_snapshot_id, operation_status,
      created_at, updated_at
   ) VALUES (
      '重复转发操作', '来信邮件-1', '个人投递-1', '转发规则-1', 1,
      '外部目标-1', 'backup@outside.test', ?, 100, 0, 0,
      '转发快照-1', 'pending', 343, 343
   )`, hash(70),
));
run(`INSERT INTO mail_forward_attempts (
        id, mail_forward_operation_id, route_snapshot_entry_id, attempt_number,
        selection_kind, attempt_status, created_at
     ) VALUES ('转发尝试-1', '转发操作-1', '转发快照条目-1', 1, 'initial', 'prepared', 344)`);
expect("转发尝试不占用户普通发送操作", get(
  `SELECT count(*) AS count FROM send_operations`,
).count === 1);

run(`INSERT INTO external_email_targets (
        id, user_id, display_email_address, canonical_email_address,
        target_status, verified_at, created_at, updated_at
     ) VALUES ('系统内目标', '用户-1', 'loop@example.com', 'loop@example.com', 'verified', 350, 350, 350)`);
run(`INSERT INTO mail_forwarding_rules (
        id, user_id, external_email_target_id, rule_version,
        scope_kind, rule_status, created_at, updated_at
     ) VALUES ('转发规则-环路', '用户-1', '系统内目标', 1, 'all_personal', 'active', 351, 351)`);
run(`INSERT INTO outbound_route_snapshots (
        id, mail_domain_id, source_route_id, source_route_version, execution_kind,
        execution_reference, payload_sha256, payload_size_bytes, created_at
     ) VALUES ('转发快照-环路', '域名-1', '路线-1', 1, 'forward',
        '转发操作-环路', ?, 100, 352)`, hash(71));
insertRouteSnapshotEntry({ id: "转发快照条目-环路", snapshotId: "转发快照-环路", priority: 0, configId: "配置-Resend", key: "resend-main", version: 1, type: "resend", limit: resendLimit, digestValue: 2, at: 352 });
expectReject("自动转发不能投向本系统管理域名", () => run(
  `INSERT INTO mail_forward_operations (
      id, source_message_id, message_delivery_id, mail_forwarding_rule_id,
      rule_version, external_email_target_id, target_canonical_email_address,
      payload_sha256, payload_size_bytes, forwarding_hop_count,
      source_marked_by_simlettra, outbound_route_snapshot_id, operation_status,
      created_at, updated_at
   ) VALUES (
      '转发操作-环路', '来信邮件-1', '个人投递-1', '转发规则-环路', 1,
      '系统内目标', 'loop@example.com', ?, 100, 0, 0,
      '转发快照-环路', 'pending', 353, 353
   )`, hash(71),
));

const originalMessageCount = get(
  `SELECT count(*) AS count FROM messages WHERE id = '来信邮件-1'`,
).count;
expect("通知和转发失败不删除原始邮件", originalMessageCount === 1);

const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
expect("五批数据外键检查为零", foreignKeyViolations.length === 0);

console.log(JSON.stringify({
  assertions: assertionCount,
  tables: tableCount,
  foreignKeyViolations: foreignKeyViolations.length,
}));
