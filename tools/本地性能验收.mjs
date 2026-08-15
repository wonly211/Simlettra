import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, URL } from 'node:url'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const migrationsDirectory = join(projectDirectory, 'migrations')
const userCount = 50
const messagesPerUser = 2_000
const messageCount = userCount * messagesPerUser
const concurrentUsers = 10
const iterationsPerUser = 20
const thresholdMilliseconds = 2_000
const benchmarkNow = 1_800_100_000_000

async function runMainBenchmark() {
  const root = await mkdtemp(join(tmpdir(), 'simlettra-performance-test-'))
  const databasePath = join(root, '性能验收.sqlite')
  let database
  try {
    database = new DatabaseSync(databasePath)
    database.exec(
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;',
    )
    createMigrationLedger(database)
    const migrations = (await readdir(migrationsDirectory))
      .filter((name) => /^\d{4}-.+\.sql$/u.test(name))
      .sort((left, right) => left.localeCompare(right, 'zh-CN'))
    await applyMigrations(database, migrations)
    seedScaleFixture(database)
    const counts = readFixtureCounts(database)
    assert.deepEqual(counts, {
      users: userCount,
      messages: messageCount,
      integrityStates: messageCount,
      headerAddresses: messageCount,
      mailboxEntries: messageCount,
    })
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
    database.exec('PRAGMA optimize; PRAGMA wal_checkpoint(TRUNCATE);')
    database.close()
    database = undefined

    const results = await Promise.all(
      Array.from({ length: concurrentUsers }, (_, index) => runWorker(databasePath, index)),
    )
    const listDurations = results.flatMap((result) => result.listDurations)
    const detailDurations = results.flatMap((result) => result.detailDurations)
    const listP95 = percentile(listDurations, 0.95)
    const detailP95 = percentile(detailDurations, 0.95)
    const listMaximum = Math.max(...listDurations)
    const detailMaximum = Math.max(...detailDurations)
    assert.ok(
      listP95 < thresholdMilliseconds,
      `收件箱列表第 95 百分位超过 ${thresholdMilliseconds} ms`,
    )
    assert.ok(
      detailP95 < thresholdMilliseconds,
      `邮件详情数据查询第 95 百分位超过 ${thresholdMilliseconds} ms`,
    )

    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'passed',
          migrationVersion: migrations.at(-1),
          fixture: {
            userCount,
            concurrentUsers,
            messageCount,
            messagesPerUser,
          },
          samples: {
            list: listDurations.length,
            detail: detailDurations.length,
          },
          milliseconds: {
            threshold: thresholdMilliseconds,
            listP95: round(listP95),
            listMaximum: round(listMaximum),
            detailP95: round(detailP95),
            detailMaximum: round(detailMaximum),
          },
          scope: [
            '全部正式 D1 迁移',
            '50 名已启用用户',
            '100000 封个人邮件',
            '10 个并发读取线程',
            '当前收件箱列表 SQL 结构',
            '当前详情授权 SQL 结构',
          ],
          excluded: ['Worker 调度', '真实网络延迟', 'KV/R2 正文读取', '浏览器渲染'],
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    database?.close()
    await rm(root, { force: true, recursive: true, maxRetries: 5, retryDelay: 200 })
  }
}

function runReadWorker() {
  const database = new DatabaseSync(workerData.databasePath)
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA query_only = ON;')
  const userId = identifier('user', workerData.workerIndex)
  const list = database.prepare(LIST_QUERY)
  const detail = database.prepare(DETAIL_QUERY)
  const firstEntrySequence = workerData.workerIndex * messagesPerUser
  const detailEntryIds = Array.from({ length: iterationsPerUser }, (_, index) =>
    identifier('entry', firstEntrySequence + ((index * 97) % messagesPerUser)),
  )

  for (let warmup = 0; warmup < 3; warmup += 1) {
    assert.equal(list.all(userId, benchmarkNow).length, 51)
    assert.ok(detail.get(userId, detailEntryIds[warmup], benchmarkNow))
  }

  const listDurations = []
  const detailDurations = []
  for (let iteration = 0; iteration < iterationsPerUser; iteration += 1) {
    let startedAt = performance.now()
    const page = list.all(userId, benchmarkNow)
    listDurations.push(performance.now() - startedAt)
    assert.equal(page.length, 51)

    startedAt = performance.now()
    const row = detail.get(userId, detailEntryIds[iteration], benchmarkNow)
    detailDurations.push(performance.now() - startedAt)
    assert.equal(row?.entry_id, detailEntryIds[iteration])
  }
  database.close()
  parentPort.postMessage({ listDurations, detailDurations })
}

function runWorker(databasePath, workerIndex) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { databasePath, workerIndex },
    })
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`性能读取线程 ${workerIndex} 退出码为 ${code}`))
    })
  })
}

function createMigrationLedger(database) {
  database.exec(`
    CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
}

async function applyMigrations(database, names) {
  for (const name of names) {
    const sql = await readFile(join(migrationsDirectory, name), 'utf8')
    database.exec('BEGIN IMMEDIATE;')
    try {
      database.exec(sql)
      database.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name)
      database.exec('COMMIT;')
    } catch (error) {
      database.exec('ROLLBACK;')
      throw new Error(`正式迁移执行失败：${name}`, { cause: error })
    }
  }
}

function seedScaleFixture(database) {
  database.exec('DROP TRIGGER validate_message_ready_insert; BEGIN IMMEDIATE;')
  const insertUser = database.prepare(
    `INSERT INTO users (
       id, status, display_name, timezone, invitation_policy,
       deletion_requested_at, deletion_due_at, deleted_at, created_at, updated_at
     ) VALUES (?, 'active', ?, 'Asia/Shanghai', 'manual', NULL, NULL, NULL, ?, ?)`,
  )
  const insertMessage = database.prepare(
    `INSERT INTO messages (
       id, origin_type, authored_by_user_id, internet_message_id, subject,
       header_date_text, header_date_at, accepted_at, sort_at, raw_size_bytes,
       attachment_count, has_attachments, created_at, updated_at
     ) VALUES (?, 'migrated', NULL, ?, ?, NULL, ?, ?, ?, 1024, 0, 0, ?, ?)`,
  )
  const insertIntegrity = database.prepare(
    `INSERT INTO message_integrity_states (
       message_id, source_completeness, integrity_status, object_set_version,
       ready_at, hidden_since, damage_code, damage_summary, created_at, updated_at
     ) VALUES (?, 'structured_only', 'ready', 1, ?, NULL, NULL, NULL, ?, ?)`,
  )
  const insertHeader = database.prepare(
    `INSERT INTO message_header_addresses (
       id, message_id, address_role, sequence_number, display_name,
       address_text, canonical_address, visibility_scope, created_at
     ) VALUES (?, ?, 'from', 0, '性能发件人', ?, ?, 'header', ?)`,
  )
  const insertEntry = database.prepare(
    `INSERT INTO mailbox_entries (
       id, message_id, mailbox_type, user_id, organization_id,
       entry_kind, base_location, occurred_at, created_at
     ) VALUES (?, ?, 'user', ?, NULL, 'received', 'inbox', ?, ?)`,
  )

  try {
    for (let userIndex = 0; userIndex < userCount; userIndex += 1) {
      insertUser.run(
        identifier('user', userIndex),
        `性能用户-${userIndex + 1}`,
        benchmarkNow,
        benchmarkNow,
      )
    }
    for (let sequence = 0; sequence < messageCount; sequence += 1) {
      const userIndex = Math.floor(sequence / messagesPerUser)
      const userId = identifier('user', userIndex)
      const messageId = identifier('message', sequence)
      const entryId = identifier('entry', sequence)
      const occurredAt = benchmarkNow - sequence
      const senderAddress = `sender-${sequence % 100}@outside.test`
      insertMessage.run(
        messageId,
        `<performance-${sequence}@outside.test>`,
        `性能邮件 ${sequence + 1}`,
        occurredAt,
        occurredAt,
        occurredAt,
        occurredAt,
        occurredAt,
      )
      insertIntegrity.run(messageId, occurredAt, occurredAt, occurredAt)
      insertHeader.run(
        identifier('header', sequence),
        messageId,
        senderAddress,
        senderAddress,
        occurredAt,
      )
      insertEntry.run(entryId, messageId, userId, occurredAt, occurredAt)
    }
    database.exec('COMMIT;')
  } catch (error) {
    database.exec('ROLLBACK;')
    throw error
  }
}

function readFixtureCounts(database) {
  return {
    users: database.prepare('SELECT COUNT(*) AS count FROM users').get().count,
    messages: database.prepare('SELECT COUNT(*) AS count FROM messages').get().count,
    integrityStates: database
      .prepare('SELECT COUNT(*) AS count FROM message_integrity_states')
      .get().count,
    headerAddresses: database
      .prepare('SELECT COUNT(*) AS count FROM message_header_addresses')
      .get().count,
    mailboxEntries: database.prepare('SELECT COUNT(*) AS count FROM mailbox_entries').get().count,
  }
}

function identifier(prefix, value) {
  return `${prefix}-${String(value).padStart(8, '0')}`
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]
}

function round(value) {
  return Math.round(value * 100) / 100
}

const LIST_QUERY = `
WITH filtered_mailbox AS (
  SELECT
    entry.id AS entry_id,
    entry.message_id,
    entry.occurred_at,
    CASE
      WHEN state.is_read IS NOT NULL THEN state.is_read
      WHEN entry.entry_kind = 'sent' THEN 1
      WHEN entry.mailbox_type = 'organization'
        AND membership.joined_at IS NOT NULL
        AND entry.occurred_at < membership.joined_at THEN 1
      ELSE 0
    END AS resolved_is_read,
    COALESCE(conversation_member.conversation_id, 'entry:' || entry.id) AS conversation_key
  FROM mailbox_entries AS entry
  JOIN messages AS message ON message.id = entry.message_id
  JOIN message_integrity_states AS integrity
    ON integrity.message_id = message.id AND integrity.integrity_status = 'ready'
  LEFT JOIN organizations AS organization ON organization.id = entry.organization_id
  LEFT JOIN organization_memberships AS membership
    ON membership.organization_id = entry.organization_id
   AND membership.user_id = ?1 AND membership.left_at IS NULL
  LEFT JOIN mailbox_user_states AS state
    ON state.mailbox_entry_id = entry.id AND state.user_id = ?1
  LEFT JOIN mailbox_conversation_entries AS conversation_member
    ON conversation_member.mailbox_entry_id = entry.id
  LEFT JOIN message_header_addresses AS sender
    ON sender.id = (
      SELECT address.id FROM message_header_addresses AS address
      WHERE address.message_id = message.id
        AND address.address_role IN ('from', 'sender')
      ORDER BY CASE address.address_role WHEN 'from' THEN 0 ELSE 1 END,
               address.sequence_number, address.id
      LIMIT 1
    )
  WHERE entry.entry_kind = 'received'
    AND COALESCE(state.location_override, entry.base_location) = 'inbox'
    AND COALESCE(state.is_archived, 0) = 0
    AND (state.location_override IS NULL OR state.location_override <> 'trash'
         OR state.trash_due_at IS NULL OR state.trash_due_at > ?2)
    AND ((entry.mailbox_type = 'user' AND entry.user_id = ?1)
         OR (entry.mailbox_type = 'organization' AND membership.id IS NOT NULL
             AND organization.status = 'active'))
), ranked_mailbox AS (
  SELECT
    filtered_mailbox.*,
    COUNT(*) OVER (PARTITION BY conversation_key) AS conversation_message_count,
    SUM(CASE WHEN resolved_is_read = 0 THEN 1 ELSE 0 END)
      OVER (PARTITION BY conversation_key) AS conversation_unread_count,
    ROW_NUMBER() OVER (
      PARTITION BY conversation_key ORDER BY occurred_at DESC, entry_id DESC
    ) AS conversation_rank
  FROM filtered_mailbox
)
SELECT entry_id, message_id, occurred_at,
       conversation_message_count, conversation_unread_count
FROM ranked_mailbox
WHERE conversation_rank = 1
ORDER BY occurred_at DESC, entry_id DESC
LIMIT 51`

const DETAIL_QUERY = `
SELECT
  entry.id AS entry_id,
  entry.message_id,
  entry.entry_kind,
  entry.base_location,
  entry.mailbox_type,
  entry.organization_id,
  organization.name AS organization_name,
  organization.creator_user_id AS organization_creator_user_id,
  message.subject,
  message.header_date_text,
  message.header_date_at,
  message.accepted_at,
  message.authored_by_user_id,
  entry.occurred_at,
  message.attachment_count,
  message.has_attachments,
  sender.display_name AS sender_display_name,
  sender.address_text AS sender_address_text,
  sender.canonical_address AS sender_canonical_address,
  state.is_read AS state_is_read,
  state.is_starred AS state_is_starred,
  state.is_archived AS state_is_archived,
  state.location_override AS state_location_override,
  state.remote_images_allowed AS state_remote_images_allowed,
  state.previous_location AS state_previous_location,
  state.trashed_at AS state_trashed_at,
  state.trash_due_at AS state_trash_due_at,
  state.hidden_at AS state_hidden_at,
  membership.joined_at AS membership_joined_at,
  CASE WHEN trusted.canonical_sender_address IS NULL THEN 0 ELSE 1 END AS sender_trusted
FROM mailbox_entries AS entry
JOIN messages AS message ON message.id = entry.message_id
JOIN message_integrity_states AS integrity
  ON integrity.message_id = message.id AND integrity.integrity_status = 'ready'
LEFT JOIN organizations AS organization ON organization.id = entry.organization_id
LEFT JOIN organization_memberships AS membership
  ON membership.organization_id = entry.organization_id
 AND membership.user_id = ?1 AND membership.left_at IS NULL
LEFT JOIN mailbox_user_states AS state
  ON state.mailbox_entry_id = entry.id AND state.user_id = ?1
LEFT JOIN message_header_addresses AS sender
  ON sender.id = (
    SELECT address.id FROM message_header_addresses AS address
    WHERE address.message_id = message.id
      AND address.address_role IN ('from', 'sender')
    ORDER BY CASE address.address_role WHEN 'from' THEN 0 ELSE 1 END,
             address.sequence_number, address.id
    LIMIT 1
  )
LEFT JOIN trusted_sender_addresses AS trusted
  ON trusted.user_id = ?1 AND trusted.canonical_sender_address = sender.canonical_address
WHERE entry.id = ?2
  AND COALESCE(state.location_override, entry.base_location) <> 'hidden'
  AND (state.location_override IS NULL OR state.location_override <> 'trash'
       OR state.trash_due_at IS NULL OR state.trash_due_at > ?3)
  AND ((entry.mailbox_type = 'user' AND entry.user_id = ?1)
       OR (entry.mailbox_type = 'organization' AND membership.id IS NOT NULL
           AND organization.status = 'active'))
LIMIT 1`

if (isMainThread) {
  await runMainBenchmark()
} else {
  runReadWorker()
}
