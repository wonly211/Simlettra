import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

const now = 1_786_556_400_000

describe('正式迁移 0021 契约', () => {
  beforeEach(async () => {
    await clearFixture()
    await seedIdentity()
  })

  it('建立收信控制、拒收、未分配时期、授权和兼容投递结构', async () => {
    const expected = [
      'inbound_receive_controls',
      'inbound_rejection_rules',
      'mailbox_entry_unallocated_deliveries',
      'receive_operation_unallocated_routes',
      'unallocated_access_grants',
      'unallocated_address_periods',
      'unallocated_message_deliveries',
    ]
    const result = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (${expected.map(() => '?').join(', ')})
       ORDER BY name`,
    )
      .bind(...expected)
      .all<{ name: string }>()

    expect(result.results.map((row) => row.name)).toEqual([...expected].sort())
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })

  it('同一规范地址同时只能存在一个开放时期', async () => {
    await insertPeriod('period-one')
    await expect(insertPeriod('period-two')).rejects.toThrow()
  })

  it('只有当前管理员能建立全域查看授权，且目标必须为启用用户', async () => {
    await env.DB.prepare(
      `UPDATE mail_domains SET catch_all_mode = 'unallocated', updated_at = ?1 WHERE id = 'domain-one'`,
    )
      .bind(now)
      .run()
    await env.DB.prepare(
      `INSERT INTO unallocated_access_grants (
        domain_id, user_id, granted_by_user_id, created_at
       ) VALUES ('domain-one', 'user-one', 'admin-one', ?1)`,
    )
      .bind(now)
      .run()

    await expect(
      env.DB.prepare(
        `INSERT INTO unallocated_access_grants (
          domain_id, user_id, granted_by_user_id, created_at
         ) VALUES ('domain-one', 'admin-one', 'user-one', ?1)`,
      )
        .bind(now)
        .run(),
    ).rejects.toThrow()
  })

  it('同一收信操作不能同时建立已分配与未分配路由', async () => {
    await env.DB.prepare(
      `UPDATE mail_domains SET catch_all_mode = 'unallocated', updated_at = ?1 WHERE id = 'domain-one'`,
    )
      .bind(now)
      .run()
    await insertPeriod('period-one')
    await insertReceiveOperation('receive-one')
    await env.DB.prepare(
      `INSERT INTO receive_operation_unallocated_routes (
        id, receive_operation_id, sequence_number, canonical_recipient_address,
        display_recipient_address, domain_id, unallocated_period_id,
        route_status, delivery_id, created_at, committed_at
       ) VALUES (
        'unallocated-route-one', 'receive-one', 0, 'unknown@example.com',
        'unknown@example.com', 'domain-one', 'period-one',
        'accepted', NULL, ?1, NULL
       )`,
    )
      .bind(now)
      .run()

    await expect(
      env.DB.prepare(
        `INSERT INTO receive_operation_routes (
          id, receive_operation_id, sequence_number,
          canonical_recipient_address, display_recipient_address,
          domain_id, address_id, address_binding_id, owner_type,
          user_id, organization_id, route_status, rejection_code,
          delivery_id, created_at, committed_at
         ) VALUES (
          'assigned-route-one', 'receive-one', 0,
          'user@example.com', 'user@example.com',
          'domain-one', 'address-one', 'binding-one', 'user',
          'user-one', NULL, 'accepted', NULL, NULL, ?1, NULL
         )`,
      )
        .bind(now)
        .run(),
    ).rejects.toThrow()
  })

  it('认领关联只能连接到时期认领用户的个人收件箱', async () => {
    await insertPeriod('period-one')
    await insertReadyMessage('message-one')
    await env.DB.prepare(
      `INSERT INTO unallocated_message_deliveries (
        id, message_id, unallocated_period_id, canonical_recipient_address,
        display_recipient_address, delivery_source, delivered_at, created_at
       ) VALUES (
        'unallocated-delivery-one', 'message-one', 'period-one',
        'unknown@example.com', 'unknown@example.com', 'external_receive', ?1, ?1
       )`,
    )
      .bind(now)
      .run()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO email_addresses (
          id, domain_id, display_address, canonical_address,
          public_label, created_at, retired_at
         ) VALUES (
          'claimed-address', 'domain-one', 'unknown@example.com',
          'unknown@example.com', NULL, ?1, NULL
         )`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO address_claims (
          canonical_address, address_id, status, reserved_until, created_at, updated_at
         ) VALUES ('unknown@example.com', 'claimed-address', 'active', NULL, ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO address_bindings (
          id, address_id, owner_type, user_id, organization_id,
          address_role, started_at, ended_at, ended_reason
         ) VALUES (
          'claimed-binding', 'claimed-address', 'user', 'user-one', NULL,
          'alias', ?1, NULL, NULL
         )`,
      ).bind(now),
    ])
    await env.DB.prepare(
      `UPDATE unallocated_address_periods
       SET period_status = 'claimed', closed_at = ?1,
           claimed_by_user_id = 'user-one', claimed_address_id = 'claimed-address',
           claimed_address_binding_id = 'claimed-binding', updated_at = ?1
       WHERE id = 'period-one'`,
    )
      .bind(now + 1)
      .run()
    await env.DB.prepare(
      `INSERT INTO mailbox_entries (
        id, message_id, mailbox_type, user_id, organization_id,
        entry_kind, base_location, occurred_at, created_at
       ) VALUES (
        'entry-one', 'message-one', 'user', 'user-one', NULL,
        'received', 'inbox', ?1, ?1
       )`,
    )
      .bind(now)
      .run()
    await env.DB.prepare(
      `INSERT INTO mailbox_entry_unallocated_deliveries (
        mailbox_entry_id, unallocated_delivery_id, created_at
       ) VALUES ('entry-one', 'unallocated-delivery-one', ?1)`,
    )
      .bind(now)
      .run()

    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })
})

async function seedIdentity(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (
        id, status, display_name, timezone, invitation_policy,
        deletion_requested_at, deletion_due_at, deleted_at, created_at, updated_at
       ) VALUES ('admin-one', 'active', '管理员', NULL, 'manual', NULL, NULL, NULL, ?1, ?1)`,
    ).bind(now),
    env.DB.prepare(
      `INSERT INTO users (
        id, status, display_name, timezone, invitation_policy,
        deletion_requested_at, deletion_due_at, deleted_at, created_at, updated_at
       ) VALUES ('user-one', 'active', '用户', NULL, 'manual', NULL, NULL, NULL, ?1, ?1)`,
    ).bind(now),
    env.DB.prepare(
      `INSERT INTO user_alias_policies (
        user_id, alias_limit, self_creation_enabled,
        updated_by_user_id, created_at, updated_at
       ) VALUES ('user-one', 20, 1, 'admin-one', ?1, ?1)`,
    ).bind(now),
    env.DB.prepare(
      `INSERT INTO mail_domains (
        id, canonical_name, display_name, status, catch_all_mode,
        paused_at, created_at, updated_at
       ) VALUES ('domain-one', 'example.com', 'example.com', 'active', 'reject', NULL, ?1, ?1)`,
    ).bind(now),
    env.DB.prepare(
      `INSERT INTO email_addresses (
        id, domain_id, display_address, canonical_address,
        public_label, created_at, retired_at
       ) VALUES ('address-one', 'domain-one', 'user@example.com', 'user@example.com', NULL, ?1, NULL)`,
    ).bind(now),
    env.DB.prepare(
      `INSERT INTO address_claims (
        canonical_address, address_id, status, reserved_until, created_at, updated_at
       ) VALUES ('user@example.com', 'address-one', 'active', NULL, ?1, ?1)`,
    ).bind(now),
    env.DB.prepare(
      `INSERT INTO address_bindings (
        id, address_id, owner_type, user_id, organization_id,
        address_role, started_at, ended_at, ended_reason
       ) VALUES ('binding-one', 'address-one', 'user', 'user-one', NULL, 'primary', ?1, NULL, NULL)`,
    ).bind(now),
    env.DB.prepare(
      `INSERT INTO system_instances (
        singleton_id, storage_mode, current_admin_user_id,
        initialized_at, created_at, updated_at
       ) VALUES (1, 'r2', 'admin-one', ?1, ?1, ?1)`,
    ).bind(now),
  ])
}

async function insertPeriod(id: string): Promise<D1Result<unknown>> {
  return env.DB.prepare(
    `INSERT INTO unallocated_address_periods (
      id, domain_id, canonical_address, display_address, period_status,
      started_at, closed_at, claimed_by_user_id, claimed_address_id,
      claimed_address_binding_id, created_at, updated_at
     ) VALUES (
      ?1, 'domain-one', 'unknown@example.com', 'unknown@example.com', 'open',
      ?2, NULL, NULL, NULL, NULL, ?2, ?2
     )`,
  )
    .bind(id, now)
    .run()
}

async function insertReceiveOperation(id: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO receive_operations (
      id, source_kind, source_event_reference, deduplication_kind,
      deduplication_key_digest, deduplication_window_started_at,
      deduplication_expires_at, message_reference, message_id,
      raw_object_id, raw_size_bytes, raw_sha256, envelope_sender_text,
      operation_status, parser_version, parsed_part_count,
      error_code, error_summary, accepted_at, visible_at,
      completed_at, created_at, updated_at
     ) VALUES (
      ?1, 'test', NULL, 'bounded_fingerprint', ?2, ?3, ?4,
      ?5, NULL, NULL, 1, ?6, 'sender@example.net',
      'intent', NULL, NULL, NULL, NULL, ?3, NULL, NULL, ?3, ?3
     )`,
  )
    .bind(
      id,
      new Uint8Array(32).fill(1),
      now,
      now + 3_600_000,
      `${id}-message`,
      new Uint8Array(32).fill(2),
    )
    .run()
}

async function insertReadyMessage(id: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages (
      id, origin_type, authored_by_user_id, internet_message_id, subject,
      header_date_text, header_date_at, accepted_at, sort_at, raw_size_bytes,
      attachment_count, has_attachments, created_at, updated_at
     ) VALUES (?1, 'received', NULL, NULL, '测试邮件', NULL, NULL, ?2, ?2, 1, 0, 0, ?2, ?2)`,
  )
    .bind(id, now)
    .run()
  await env.DB.prepare(
    `INSERT INTO object_registry (
      id, storage_mode, object_key, owner_kind, owner_reference, message_id,
      object_role, logical_part_key, sequence_number, generation,
      required_for_visibility, is_current, expected_size_bytes, expected_sha256,
      actual_size_bytes, actual_sha256, media_type, untrusted_file_name,
      content_disposition, content_id, producer_version, backend_version_reference,
      object_status, stored_at, verified_at, consistency_checked_at, activated_at,
      superseded_at, delete_after, deleted_at, created_at, updated_at
     ) VALUES (
      ?1, 'r2', ?2, 'message', ?3, ?3, 'raw_mime', 'body', 0, 1,
      1, 1, 1, ?4, 1, ?4, 'message/rfc822', NULL, NULL, NULL,
      'test', NULL, 'active', ?5, ?5, ?5, ?5, NULL, NULL, NULL, ?5, ?5
     )`,
  )
    .bind(`${id}-raw`, `test/${id}/raw`, id, new Uint8Array(32).fill(3), now)
    .run()
  await env.DB.prepare(
    `INSERT INTO object_registry (
      id, storage_mode, object_key, owner_kind, owner_reference, message_id,
      object_role, logical_part_key, sequence_number, generation,
      required_for_visibility, is_current, expected_size_bytes, expected_sha256,
      actual_size_bytes, actual_sha256, media_type, untrusted_file_name,
      content_disposition, content_id, producer_version, backend_version_reference,
      object_status, stored_at, verified_at, consistency_checked_at, activated_at,
      superseded_at, delete_after, deleted_at, created_at, updated_at
     ) VALUES (
      ?1, 'r2', ?2, 'message', ?3, ?3, 'plain_body', 'body', 0, 1,
      1, 1, 0, ?4, 0, ?4, 'text/plain', NULL, NULL, NULL,
      'test', NULL, 'active', ?5, ?5, ?5, ?5, NULL, NULL, NULL, ?5, ?5
     )`,
  )
    .bind(`${id}-body`, `test/${id}/body`, id, new Uint8Array(32).fill(4), now)
    .run()
  await env.DB.prepare(
    `INSERT INTO message_integrity_states (
      message_id, source_completeness, integrity_status, object_set_version,
      ready_at, hidden_since, damage_code, damage_summary, created_at, updated_at
     ) VALUES (?1, 'raw_mime', 'ready', 1, ?2, NULL, NULL, NULL, ?2, ?2)`,
  )
    .bind(id, now)
    .run()
}

async function clearFixture(): Promise<void> {
  const tables = [
    'mailbox_entry_unallocated_deliveries',
    'mailbox_entries',
    'receive_operation_unallocated_routes',
    'receive_operation_routes',
    'receive_operations',
    'unallocated_message_deliveries',
    'unallocated_access_grants',
    'unallocated_address_periods',
    'message_integrity_states',
    'object_registry',
    'messages',
    'inbound_rejection_rules',
    'inbound_receive_controls',
    'system_instances',
    'address_bindings',
    'address_claims',
    'email_addresses',
    'mail_domains',
    'user_alias_policies',
    'users',
  ]
  for (const table of tables) await env.DB.prepare(`DELETE FROM ${table}`).run()
}
