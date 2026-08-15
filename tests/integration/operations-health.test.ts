import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  completeScheduledMaintenanceRun,
  failScheduledMaintenanceRun,
  getOperationsHealthOverview,
  OperationsHealthPermissionError,
  startScheduledMaintenanceRun,
} from '../../src/modules/operations-health/public'
import { handleScheduledMaintenance } from '../../src/worker/handlers/scheduled'

const NOW = 1_800_000_000_000

describe('运行健康状态', () => {
  it('正式迁移建立受约束的定时维护心跳表', async () => {
    const objects = await env.DB.prepare(
      `SELECT type, name FROM sqlite_master
       WHERE name IN (
         'scheduled_maintenance_runs',
         'validate_scheduled_maintenance_transition',
         'prevent_scheduled_maintenance_identity_change'
       ) ORDER BY type, name`,
    ).all<{ type: string; name: string }>()
    expect(objects.results).toHaveLength(3)
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })

  it('只允许唯一管理员读取且空系统明确显示未知和未配置', async () => {
    await insertAdministrator('admin-health')
    await expect(
      getOperationsHealthOverview({
        database: env.DB,
        actorUserId: 'member-health',
        storageMode: 'r2',
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(OperationsHealthPermissionError)

    const overview = await getOperationsHealthOverview({
      database: env.DB,
      actorUserId: 'admin-health',
      storageMode: 'r2',
      now: NOW,
    })
    expect(overview.overallStatus).toBe('unknown')
    expect(overview.inbound.status).toBe('unknown')
    expect(overview.outbound.status).toBe('not_configured')
    expect(overview.storage.status).toBe('unknown')
    expect(overview.scheduled.status).toBe('unknown')
  })

  it('聚合停滞收信、结果未知发信、资源停止线和后台任务异常', async () => {
    await insertAdministrator('admin-attention')
    await insertAttentionEvidence()

    const overview = await getOperationsHealthOverview({
      database: env.DB,
      actorUserId: 'admin-attention',
      storageMode: 'r2',
      now: NOW,
    })
    expect(overview).toMatchObject({
      overallStatus: 'attention',
      inbound: { status: 'attention', stalledCount: 1 },
      outbound: {
        status: 'attention',
        activeProviderCount: 1,
        activeRouteCount: 1,
        stalledRecipientCount: 1,
        unknownRecipientCount: 1,
      },
      storage: { status: 'attention', stoppedResourceCount: 1 },
      scheduled: { status: 'attention', needsAttentionTaskCount: 1, overdueTaskCount: 1 },
    })
  })

  it('定时维护心跳只允许从运行中结束并保存安全步骤错误', async () => {
    const succeeded = await startScheduledMaintenanceRun({
      database: env.DB,
      runReference: 'scheduled-success',
      now: NOW,
    })
    await completeScheduledMaintenanceRun({ database: env.DB, run: succeeded, now: NOW + 100 })

    const failed = await startScheduledMaintenanceRun({
      database: env.DB,
      runReference: 'scheduled-failure',
      now: NOW + 200,
    })
    await failScheduledMaintenanceRun({
      database: env.DB,
      run: failed,
      step: 'platform_resources',
      now: NOW + 300,
    })

    const rows = await env.DB.prepare(
      `SELECT run_reference, run_status, current_step, error_code, error_summary
       FROM scheduled_maintenance_runs ORDER BY started_at`,
    ).all<{
      run_reference: string
      run_status: string
      current_step: string
      error_code: string | null
      error_summary: string | null
    }>()
    expect(rows.results).toEqual([
      {
        run_reference: 'scheduled-success',
        run_status: 'succeeded',
        current_step: 'completed',
        error_code: null,
        error_summary: null,
      },
      {
        run_reference: 'scheduled-failure',
        run_status: 'failed',
        current_step: 'platform_resources',
        error_code: 'scheduled_platform_resources_failed',
        error_summary: '定时维护在 刷新资源用量 步骤失败',
      },
    ])
    await expect(
      env.DB.prepare(
        `UPDATE scheduled_maintenance_runs SET run_status = 'running'
         WHERE run_reference = 'scheduled-success'`,
      ).run(),
    ).rejects.toThrow(/不能倒退/u)
  })

  it('正式定时维护处理器完成后留下成功心跳', async () => {
    await handleScheduledMaintenance(env)

    const latest = await env.DB.prepare(
      `SELECT run_status, current_step, error_code, completed_at
       FROM scheduled_maintenance_runs ORDER BY started_at DESC, id DESC LIMIT 1`,
    ).first<{
      run_status: string
      current_step: string
      error_code: string | null
      completed_at: number | null
    }>()
    expect(latest).toMatchObject({
      run_status: 'succeeded',
      current_step: 'completed',
      error_code: null,
    })
    expect(latest?.completed_at).toEqual(expect.any(Number))
  })
})

async function insertAdministrator(userId: string) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (
         id, status, display_name, timezone, invitation_policy,
         deletion_requested_at, deletion_due_at, deleted_at, created_at, updated_at
       ) VALUES (?1, 'active', '系统管理员', 'Asia/Shanghai', 'manual',
         NULL, NULL, NULL, ?2, ?2)`,
    ).bind(userId, NOW - 100_000),
    env.DB.prepare(
      `INSERT INTO system_instances (
         singleton_id, storage_mode, current_admin_user_id,
         initialized_at, created_at, updated_at
       ) VALUES (1, 'r2', ?1, ?2, ?2, ?2)`,
    ).bind(userId, NOW - 100_000),
  ])
}

async function insertAttentionEvidence() {
  const old = NOW - 20 * 60 * 1000
  const recent = NOW - 60_000
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO mail_domains (
         id, canonical_name, display_name, status, catch_all_mode,
         paused_at, created_at, updated_at
       ) VALUES ('health-domain', 'example.com', 'example.com', 'active', 'reject', NULL, ?1, ?1)`,
    ).bind(old),
    env.DB.prepare(
      `INSERT INTO receive_operations (
         id, source_kind, source_event_reference, deduplication_kind,
         deduplication_key_digest, deduplication_window_started_at,
         deduplication_expires_at, message_reference, message_id, raw_object_id,
         raw_size_bytes, raw_sha256, envelope_sender_text, operation_status,
         parser_version, parsed_part_count, error_code, error_summary,
         accepted_at, visible_at, completed_at, created_at, updated_at
       ) VALUES (
         'health-receive', 'email_routing', 'health-event', 'provider_event',
         zeroblob(32), NULL, NULL, 'health-message', NULL, NULL,
         100, zeroblob(32), 'sender@example.net', 'intent',
         NULL, NULL, NULL, NULL, ?1, NULL, NULL, ?1, ?1
       )`,
    ).bind(old),
    env.DB.prepare(
      `INSERT INTO outbound_provider_configs (
         id, configuration_key, configuration_version, display_name, provider_type,
         public_options_json, credential_ciphertext, credential_nonce,
         credential_algorithm, credential_key_version, credential_updated_at,
         configuration_status, last_tested_at, last_test_result, last_test_summary,
         disabled_at, retired_at, created_at, updated_at
       ) VALUES (
         'health-provider', 'primary', 1, 'Resend', 'resend', '{}', X'01',
         zeroblob(12), 'AES-GCM-256', 1, ?1, 'active', ?1, 'success', NULL,
         NULL, NULL, ?1, ?1
       )`,
    ).bind(recent),
    env.DB.prepare(
      `INSERT INTO domain_outbound_routes (
         id, mail_domain_id, route_version, route_status,
         created_at, activated_at, superseded_at, disabled_at, updated_at
       ) VALUES ('health-route', 'health-domain', 1, 'draft', ?1, NULL, NULL, NULL, ?1)`,
    ).bind(recent),
    env.DB.prepare(
      `INSERT INTO domain_outbound_route_entries (
         id, route_id, priority_number, provider_config_id, created_at
       ) VALUES ('health-route-entry', 'health-route', 0, 'health-provider', ?1)`,
    ).bind(recent),
    env.DB.prepare(
      `UPDATE domain_outbound_routes
       SET route_status = 'active', activated_at = ?1, updated_at = ?1
       WHERE id = 'health-route'`,
    ).bind(recent),
  ])
  await insertSendHealthRows(old, recent)
  await insertResourceHealthRows(recent)
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO scheduled_maintenance_runs (
         id, run_reference, run_status, current_step, error_code, error_summary,
         started_at, completed_at, created_at, updated_at
       ) VALUES (
         'health-scheduled', 'health-scheduled', 'failed', 'due_background_tasks',
         'scheduled_due_background_tasks_failed', '定时维护在补投后台任务步骤失败',
         ?1, ?2, ?1, ?2
       )`,
    ).bind(old, old + 1_000),
    env.DB.prepare(
      `INSERT INTO background_tasks (
         id, task_type, target_type, target_reference, input_version,
         task_key_digest, task_status, priority, attempt_count, max_attempts,
         next_attempt_at, lease_owner_reference, lease_token, lease_expires_at,
         last_error_code, last_error_summary, last_error_at, completed_at, created_at, updated_at
       ) VALUES (
         'health-task-attention', 'health_check', 'health', 'attention', 1,
         randomblob(32), 'pending', 5, 0, 5,
         ?1, NULL, 0, NULL, NULL, NULL, NULL, NULL, ?1, ?1
       )`,
    ).bind(old),
    env.DB.prepare(
      `INSERT INTO background_tasks (
         id, task_type, target_type, target_reference, input_version,
         task_key_digest, task_status, priority, attempt_count, max_attempts,
         next_attempt_at, lease_owner_reference, lease_token, lease_expires_at,
         last_error_code, last_error_summary, last_error_at, completed_at, created_at, updated_at
       ) VALUES (
         'health-task-overdue', 'health_check', 'health', 'overdue', 1,
         randomblob(32), 'pending', 5, 0, 5,
         ?1, NULL, 0, NULL, NULL, NULL, NULL, NULL, ?1, ?1
       )`,
    ).bind(old),
  ])
  await env.DB.prepare(
    `UPDATE background_tasks
     SET task_status = 'running', attempt_count = 1, lease_token = 1,
         next_attempt_at = NULL, lease_owner_reference = 'health-worker',
         lease_expires_at = ?1, updated_at = ?2
     WHERE id = 'health-task-attention'`,
  )
    .bind(NOW + 60_000, old + 1)
    .run()
  await env.DB.prepare(
    `UPDATE background_tasks
     SET task_status = 'needs_attention', lease_owner_reference = NULL,
         lease_expires_at = NULL, last_error_code = 'health_attention',
         last_error_summary = '后台任务需要检查', last_error_at = ?1, updated_at = ?1
     WHERE id = 'health-task-attention'`,
  )
    .bind(old + 2)
    .run()
}

async function insertSendHealthRows(old: number, recent: number) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO outbound_route_snapshots (
         id, mail_domain_id, source_route_id, source_route_version,
         execution_kind, execution_reference, payload_sha256, payload_size_bytes, created_at
       ) VALUES (
         'health-route-snapshot', 'health-domain', 'health-route', 1,
         'send', 'health-send', zeroblob(32), 100, ?1
       )`,
    ).bind(recent),
    env.DB.prepare(
      `INSERT INTO outbound_route_snapshot_entries (
         id, route_snapshot_id, priority_number, provider_config_id,
         configuration_key, configuration_version, provider_type,
         effective_size_limit_bytes, provider_options_digest, created_at
       ) VALUES (
         'health-route-snapshot-entry', 'health-route-snapshot', 0, 'health-provider',
         'primary', 1, 'resend', 20000000, zeroblob(32), ?1
       )`,
    ).bind(recent),
  ])
  const userId = 'admin-attention'
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (
         id, origin_type, authored_by_user_id, internet_message_id, subject,
         header_date_text, header_date_at, accepted_at, sort_at, raw_size_bytes,
         attachment_count, has_attachments, created_at, updated_at
       ) VALUES ('health-send-message', 'composed', ?1, NULL, '', NULL, NULL,
         ?2, ?2, 100, 0, 0, ?2, ?2)`,
    ).bind(userId, recent),
    env.DB.prepare(
      `INSERT INTO email_addresses (
         id, domain_id, display_address, canonical_address, public_label,
         created_at, retired_at
       ) VALUES ('health-sender', 'health-domain', 'owner@example.com',
         'owner@example.com', NULL, ?1, NULL)`,
    ).bind(recent),
    env.DB.prepare(
      `INSERT INTO address_claims (
         canonical_address, address_id, status, reserved_until, created_at, updated_at
       ) VALUES ('owner@example.com', 'health-sender', 'active', NULL, ?1, ?1)`,
    ).bind(recent),
    env.DB.prepare(
      `INSERT INTO address_bindings (
         id, address_id, owner_type, user_id, organization_id,
         address_role, started_at, ended_at, ended_reason
       ) VALUES ('health-sender-binding', 'health-sender', 'user', ?1, NULL,
         'primary', ?2, NULL, NULL)`,
    ).bind(userId, recent),
    env.DB.prepare(
      `INSERT INTO object_registry (
         id, storage_mode, object_key, owner_kind, owner_reference, message_id,
         object_role, logical_part_key, sequence_number, generation,
         required_for_visibility, is_current, expected_size_bytes, expected_sha256,
         actual_size_bytes, actual_sha256, media_type, untrusted_file_name,
         content_disposition, content_id, producer_version, backend_version_reference,
         object_status, stored_at, verified_at, consistency_checked_at, activated_at,
         superseded_at, delete_after, deleted_at, created_at, updated_at
       ) VALUES (
         'health-final-mime', 'r2', 'health/final.eml', 'message',
         'health-send-message', 'health-send-message', 'final_mime', 'final', 0, 1,
         1, 1, 100, zeroblob(32), 100, zeroblob(32), 'message/rfc822', NULL,
         NULL, NULL, 'health-test', NULL, 'active', ?1, ?1, ?1, ?1,
         NULL, NULL, NULL, ?1, ?1
       )`,
    ).bind(recent),
    env.DB.prepare(
      `INSERT INTO object_registry (
         id, storage_mode, object_key, owner_kind, owner_reference, message_id,
         object_role, logical_part_key, sequence_number, generation,
         required_for_visibility, is_current, expected_size_bytes, expected_sha256,
         actual_size_bytes, actual_sha256, media_type, untrusted_file_name,
         content_disposition, content_id, producer_version, backend_version_reference,
         object_status, stored_at, verified_at, consistency_checked_at, activated_at,
         superseded_at, delete_after, deleted_at, created_at, updated_at
       ) VALUES (
         'health-plain-body', 'r2', 'health/plain.txt', 'message',
         'health-send-message', 'health-send-message', 'plain_body', 'plain', 0, 1,
         1, 1, 0, zeroblob(32), 0, zeroblob(32), 'text/plain; charset=utf-8', NULL,
         NULL, NULL, 'health-test', NULL, 'active', ?1, ?1, ?1, ?1,
         NULL, NULL, NULL, ?1, ?1
       )`,
    ).bind(recent),
    env.DB.prepare(
      `INSERT INTO message_integrity_states (
         message_id, source_completeness, integrity_status, object_set_version,
         ready_at, hidden_since, damage_code, damage_summary, created_at, updated_at
       ) VALUES (
         'health-send-message', 'final_mime', 'ready', 1,
         ?1, NULL, NULL, NULL, ?1, ?1
       )`,
    ).bind(recent),
    env.DB.prepare(
      `INSERT INTO mailbox_entries (
         id, message_id, mailbox_type, user_id, organization_id,
         entry_kind, base_location, occurred_at, created_at
       ) VALUES ('health-sent-entry', 'health-send-message', 'user', ?1, NULL,
         'sent', 'sent', ?2, ?2)`,
    ).bind(userId, recent),
    env.DB.prepare(
      `INSERT INTO drafts (
         id, owner_user_id, status, sender_address_id, compose_kind,
         source_message_id, source_reference, conflict_parent_draft_id,
         current_revision_number, trashed_at, trash_due_at, consumed_at,
         deleting_at, created_at, updated_at
       ) VALUES (
         'health-draft', ?1, 'active', 'health-sender', 'new',
         NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL, ?2, ?2
       )`,
    ).bind(userId, recent),
    env.DB.prepare(
      `INSERT INTO send_operations (
         id, operator_user_id, source_draft_id, source_draft_reference,
         source_draft_revision_number, message_id, sent_mailbox_entry_id,
         sender_address_id, sender_address_binding_id, sent_mailbox_type,
         sent_user_id, sent_organization_id, compose_kind, source_message_id,
         source_reference, recipient_count, internal_recipient_count,
         external_recipient_count, quota_recipient_units, payload_sha256,
         payload_size_bytes, effective_size_limit_bytes, outbound_route_snapshot_id,
         workflow_status, accepted_at, created_at, updated_at,
         final_mime_object_id, payload_generator_version
       ) VALUES (
         'health-send', ?1, 'health-draft', 'health-draft', 1, 'health-send-message',
         'health-sent-entry', 'health-sender', 'health-sender-binding', 'user',
         ?1, NULL, 'new', NULL, NULL, 2, 0, 2, 2, zeroblob(32),
         100, 20000000, 'health-route-snapshot', 'processing', ?2, ?2, ?2,
         'health-final-mime', 'health-test'
       )`,
    ).bind(userId, recent),
    env.DB.prepare(
      `INSERT INTO send_recipients (
         id, send_operation_id, recipient_role, sequence_number, display_name,
         address_text, canonical_address, deduplication_key, route_channel,
         message_delivery_id, delivery_status, status_version, status_updated_at,
         failure_code, failure_detail, complained_at, last_provider_reference,
         created_at, updated_at
       ) VALUES
       ('health-recipient-stalled', 'health-send', 'to', 0, NULL,
        'first@example.net', 'first@example.net', randomblob(32), 'external', NULL,
        'waiting', 1, ?1, NULL, NULL, NULL, NULL, ?1, ?1),
       ('health-recipient-unknown', 'health-send', 'to', 1, NULL,
        'second@example.net', 'second@example.net', randomblob(32), 'external', NULL,
        'unknown', 1, ?2, 'network_unknown', '结果未知', NULL, NULL, ?2, ?2)`,
    ).bind(old, recent),
  ])
}

async function insertResourceHealthRows(recent: number) {
  await env.DB.batch([
    resourceSnapshotStatement('health-d1-snapshot', 'd1', 100_000_000, recent),
    resourceSnapshotStatement('health-r2-snapshot', 'r2', 9_700_000_000, recent),
  ])
}

function resourceSnapshotStatement(id: string, kind: 'd1' | 'r2', used: number, now: number) {
  const freeLimit = kind === 'd1' ? 5_000_000_000 : 10_000_000_000
  const currentLimit = kind === 'd1' ? 500_000_000 : 10_000_000_000
  return env.DB.prepare(
    `INSERT INTO platform_resource_snapshots (
       id, resource_kind, scope_kind, scope_reference, free_limit_bytes,
       current_resource_limit_bytes, account_used_bytes, simlettra_used_bytes,
       remaining_bytes, current_resource_remaining_bytes, item_count,
       data_source, fetch_status, observed_at, fetched_at, error_code, created_at
     ) VALUES (?1, ?2, 'account', 'health', ?3, ?4, ?5, ?5,
       ?6, ?7, 1, 'cloudflare_api', 'success', ?8, ?8, NULL, ?8)`,
  ).bind(
    id,
    kind,
    freeLimit,
    currentLimit,
    used,
    Math.max(0, freeLimit - used),
    Math.max(0, currentLimit - used),
    now,
  )
}
