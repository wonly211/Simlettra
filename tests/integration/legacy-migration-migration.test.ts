import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

const now = Date.now()

describe('正式迁移 0019 契约', () => {
  it('建立迁移运行、检查点、映射、失败、对账、来源和密码结果', async () => {
    const expected = [
      'migrated_message_sources',
      'migration_checkpoints',
      'migration_failures',
      'migration_reconciliations',
      'migration_runs',
      'migration_source_mappings',
      'migration_user_password_results',
    ]
    const rows = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'migration_%' OR name = 'migrated_message_sources'
       ORDER BY name`,
    ).all<{ name: string }>()
    const names = new Set(rows.results.map((row) => row.name))
    expect(expected.filter((name) => names.has(name))).toEqual(expected)
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })

  it('正式迁移必须引用同来源同规则的成功演练', async () => {
    const snapshot = new Uint8Array(32).fill(1)
    await expect(
      env.DB.prepare(
        `INSERT INTO migration_runs (
          id, run_mode, source_system, source_version, source_reference_commit,
          source_snapshot_sha256, snapshot_format_version, migration_rules_version,
          target_version, rehearsal_run_id, rehearsal_report_sha256,
          run_status, created_at, updated_at
         ) VALUES (
          'formal-missing', 'formal', 'simletter', 'legacy-1', 'reference',
          ?1, 1, 1, '0019', 'missing-rehearsal', ?2,
          'planned', ?3, ?3
         )`,
      )
        .bind(snapshot, new Uint8Array(32).fill(2), now)
        .run(),
    ).rejects.toThrow(/成功演练/u)

    await env.DB.prepare(
      `INSERT INTO migration_runs (
        id, run_mode, source_system, source_version, source_reference_commit,
        source_snapshot_sha256, snapshot_format_version, migration_rules_version,
        target_version, run_status, created_at, updated_at
       ) VALUES (
        'rehearsal-ok', 'rehearsal', 'simletter', 'legacy-1', 'reference',
        ?1, 1, 1, '0019', 'running', ?2, ?2
       )`,
    )
      .bind(snapshot, now)
      .run()
    await insertMatchedReconciliations('rehearsal-ok')
    await env.DB.prepare(
      `UPDATE migration_runs
       SET run_status = 'succeeded', completed_at = ?1, updated_at = ?1
       WHERE id = 'rehearsal-ok'`,
    )
      .bind(now + 1)
      .run()

    await env.DB.prepare(
      `INSERT INTO migration_runs (
        id, run_mode, source_system, source_version, source_reference_commit,
        source_snapshot_sha256, snapshot_format_version, migration_rules_version,
        target_version, rehearsal_run_id, rehearsal_report_sha256,
        run_status, created_at, updated_at
       ) VALUES (
        'formal-ok', 'formal', 'simletter', 'legacy-1', 'reference',
        ?1, 1, 1, '0019', 'rehearsal-ok', ?2,
        'planned', ?3, ?3
       )`,
    )
      .bind(snapshot, new Uint8Array(32).fill(2), now)
      .run()
  })

  it('来源映射不可修改且七类对账全部匹配后才能成功', async () => {
    const snapshot = new Uint8Array(32).fill(3)
    await env.DB.prepare(
      `INSERT INTO migration_runs (
        id, run_mode, source_system, source_version, source_reference_commit,
        source_snapshot_sha256, snapshot_format_version, migration_rules_version,
        target_version, run_status, created_at, updated_at
       ) VALUES (
        'rehearsal-rules', 'rehearsal', 'simletter', 'legacy-1', 'reference',
        ?1, 1, 1, '0019', 'running', ?2, ?2
       )`,
    )
      .bind(snapshot, now)
      .run()
    await env.DB.prepare(
      `INSERT INTO migration_source_mappings (
        id, source_system, source_snapshot_sha256, source_entity_type,
        source_entity_id, source_content_sha256, target_entity_type,
        target_entity_reference, created_by_migration_run_id, created_at
       ) VALUES ('mapping-one', 'simletter', ?1, 'user', '1', ?2, 'user', 'target-one',
                 'rehearsal-rules', ?3)`,
    )
      .bind(snapshot, new Uint8Array(32).fill(4), now)
      .run()
    await expect(
      env.DB.prepare(
        `UPDATE migration_source_mappings
         SET target_entity_reference = 'target-two' WHERE id = 'mapping-one'`,
      ).run(),
    ).rejects.toThrow(/不可修改/u)
    await expect(
      env.DB.prepare(
        `UPDATE migration_runs
         SET run_status = 'succeeded', completed_at = ?1, updated_at = ?1
         WHERE id = 'rehearsal-rules'`,
      )
        .bind(now + 1)
        .run(),
    ).rejects.toThrow(/对账/u)
    await insertMatchedReconciliations('rehearsal-rules')
    await env.DB.prepare(
      `UPDATE migration_runs
       SET run_status = 'succeeded', completed_at = ?1, updated_at = ?1
       WHERE id = 'rehearsal-rules'`,
    )
      .bind(now + 1)
      .run()
  })

  it('只有迁移邮件可以使用结构化正文进入就绪状态', async () => {
    const migratedId = 'migration-structured-message'
    const composedId = 'composed-structured-message'
    await insertMessageWithBody(migratedId, 'migrated')
    await env.DB.prepare(
      `INSERT INTO message_integrity_states (
        message_id, source_completeness, integrity_status, object_set_version,
        ready_at, hidden_since, damage_code, damage_summary, created_at, updated_at
       ) VALUES (?1, 'structured_only', 'ready', 1, ?2, NULL, NULL, NULL, ?2, ?2)`,
    )
      .bind(migratedId, now)
      .run()

    await insertMessageWithBody(composedId, 'received')
    await expect(
      env.DB.prepare(
        `INSERT INTO message_integrity_states (
          message_id, source_completeness, integrity_status, object_set_version,
          ready_at, hidden_since, damage_code, damage_summary, created_at, updated_at
         ) VALUES (?1, 'structured_only', 'ready', 1, ?2, NULL, NULL, NULL, ?2, ?2)`,
      )
        .bind(composedId, now)
        .run(),
    ).rejects.toThrow(/必要对象/u)
  })
})

const entityTypes = ['user', 'domain', 'address', 'message', 'body', 'attachment', 'star']

async function insertMatchedReconciliations(runId: string) {
  await env.DB.batch(
    entityTypes.map((entityType, index) =>
      env.DB.prepare(
        `INSERT INTO migration_reconciliations (
          id, migration_run_id, entity_type, expected_count, scanned_count,
          succeeded_count, skipped_count, failed_count, reconciliation_status,
          created_at, updated_at
         ) VALUES (?1, ?2, ?3, 0, 0, 0, 0, 0, 'matched', ?4, ?4)`,
      ).bind(`reconciliation-${runId}-${index}`, runId, entityType, now),
    ),
  )
}

async function insertMessageWithBody(id: string, originType: 'migrated' | 'received') {
  const bodyId = `${id}-body`
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (
        id, origin_type, authored_by_user_id, subject, accepted_at, sort_at,
        raw_size_bytes, attachment_count, has_attachments, created_at, updated_at
       ) VALUES (?1, ?2, NULL, '', ?3, ?3, 0, 0, 0, ?3, ?3)`,
    ).bind(id, originType, now),
    env.DB.prepare(
      `INSERT INTO object_registry (
        id, storage_mode, object_key, owner_kind, owner_reference, message_id,
        object_role, logical_part_key, sequence_number, generation,
        required_for_visibility, is_current, expected_size_bytes, expected_sha256,
        actual_size_bytes, actual_sha256, media_type, producer_version,
        object_status, stored_at, verified_at, activated_at, created_at, updated_at
       ) VALUES (
        ?1, 'r2', ?2, 'message', ?3, ?3,
        'plain_body', 'plain', 0, 1, 1, 1, 0, ?4,
        0, ?4, 'text/plain; charset=utf-8', 'migration-test',
        'active', ?5, ?5, ?5, ?5, ?5
       )`,
    ).bind(bodyId, `migration-test/${bodyId}`, id, new Uint8Array(32), now),
  ])
}
