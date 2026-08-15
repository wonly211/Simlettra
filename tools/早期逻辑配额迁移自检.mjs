import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const migration = await readFile(
  join(root, 'migrations', '0024-修复早期逻辑配额表兼容性.sql'),
  'utf8',
)
const database = new DatabaseSync(':memory:')
const missingUsageEntries = process.argv.includes('--缺少用量账本')

try {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY NOT NULL,
      action_name TEXT NOT NULL,
      target_reference TEXT NOT NULL,
      occurred_at INTEGER NOT NULL
    );
    CREATE TABLE logical_storage_quota_policies (
      id TEXT PRIMARY KEY NOT NULL,
      storage_mode TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      user_id TEXT,
      organization_id TEXT,
      policy_version INTEGER NOT NULL,
      limit_bytes INTEGER NOT NULL,
      policy_status TEXT NOT NULL,
      effective_at INTEGER NOT NULL,
      retired_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
    );
    CREATE TABLE logical_storage_usage_accounts (
      id TEXT PRIMARY KEY NOT NULL,
      storage_mode TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      user_id TEXT,
      organization_id TEXT,
      committed_bytes INTEGER NOT NULL,
      reserved_bytes INTEGER NOT NULL,
      usage_version INTEGER NOT NULL,
      reconciled_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
    );
    CREATE TABLE logical_storage_reservations (
      id TEXT PRIMARY KEY NOT NULL,
      storage_usage_account_id TEXT NOT NULL,
      quota_policy_id TEXT NOT NULL,
      operation_kind TEXT NOT NULL,
      operation_reference TEXT NOT NULL,
      reserved_bytes INTEGER NOT NULL,
      limit_bytes_snapshot INTEGER NOT NULL,
      reservation_key_digest BLOB NOT NULL UNIQUE,
      reservation_status TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      committed_at INTEGER,
      released_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (storage_usage_account_id)
        REFERENCES logical_storage_usage_accounts (id) ON DELETE CASCADE,
      FOREIGN KEY (quota_policy_id)
        REFERENCES logical_storage_quota_policies (id) ON DELETE RESTRICT
    );
    CREATE TABLE logical_storage_usage_entries (
      id TEXT PRIMARY KEY NOT NULL,
      storage_usage_account_id TEXT NOT NULL,
      storage_reservation_id TEXT,
      entry_kind TEXT NOT NULL,
      owner_reference TEXT NOT NULL,
      bytes_delta INTEGER NOT NULL,
      idempotency_key_digest BLOB NOT NULL UNIQUE,
      committed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (storage_usage_account_id)
        REFERENCES logical_storage_usage_accounts (id) ON DELETE CASCADE,
      FOREIGN KEY (storage_reservation_id)
        REFERENCES logical_storage_reservations (id) ON DELETE SET NULL
    );

    INSERT INTO users VALUES ('user-1');
    INSERT INTO organizations VALUES ('organization-1');
    INSERT INTO logical_storage_quota_policies VALUES
      ('logical-storage-kv-system-v1', 'kv', 'system_default', NULL, NULL,
       1, 100000000, 'active', 0, NULL, 0, 0),
      ('logical-storage-r2-system-v1', 'r2', 'system_default', NULL, NULL,
       1, 1000000000, 'active', 0, NULL, 0, 0);
    INSERT INTO logical_storage_usage_accounts VALUES
      ('account-user', 'r2', 'user', 'user-1', NULL, 20, 0, 2, NULL, 0, 10),
      ('account-organization', 'r2', 'organization', NULL, 'organization-1',
       0, 0, 1, NULL, 0, 0);
    INSERT INTO logical_storage_reservations VALUES
      ('reservation-1', 'account-user', 'logical-storage-r2-system-v1',
       'draft', 'draft:test', 20, 1000000000, zeroblob(32),
       'committed', 100, 20, NULL, 0, 20);
    INSERT INTO logical_storage_usage_entries VALUES
      ('entry-1', 'account-user', 'reservation-1', 'draft', 'draft:test',
       20, randomblob(32), 20, 20);
  `)

  if (missingUsageEntries) database.exec('DROP TABLE logical_storage_usage_entries;')

  database.exec(migration)

  assert.deepEqual(
    database
      .prepare(
        `SELECT storage_mode, default_owner_type, limit_bytes
         FROM logical_storage_quota_policies
         WHERE owner_type = 'system_default' AND policy_status = 'active'
         ORDER BY storage_mode, default_owner_type`,
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { storage_mode: 'kv', default_owner_type: 'organization', limit_bytes: 100000000 },
      { storage_mode: 'kv', default_owner_type: 'user', limit_bytes: 100000000 },
      { storage_mode: 'r2', default_owner_type: 'organization', limit_bytes: 1000000000 },
      { storage_mode: 'r2', default_owner_type: 'user', limit_bytes: 1000000000 },
    ],
  )
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT quota_policy_id, reservation_status
         FROM logical_storage_reservations WHERE id = 'reservation-1'`,
        )
        .get(),
    },
    {
      quota_policy_id: 'logical-storage-r2-user-v1',
      reservation_status: 'committed',
    },
  )
  if (missingUsageEntries) {
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM logical_storage_usage_entries').get().count,
      0,
    )
  } else {
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT storage_reservation_id, bytes_delta
             FROM logical_storage_usage_entries WHERE id = 'entry-1'`,
          )
          .get(),
      },
      { storage_reservation_id: 'reservation-1', bytes_delta: 20 },
    )
  }
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'trigger' AND name LIKE '%logical_storage%'`,
      )
      .get().count,
    9,
  )
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'table' AND name LIKE '%0024_snapshot'`,
      )
      .get().count,
    0,
  )

  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'passed',
        defaults: 4,
        reservations: 1,
        usageEntries: missingUsageEntries ? 0 : 1,
        missingUsageEntries,
        foreignKeyViolations: 0,
        restoredTriggers: 9,
      },
      null,
      2,
    )}\n`,
  )
} finally {
  database.close()
}
