interface Env {
  DB: D1Database;
  MAIL_KV: KVNamespace;
  MAIL_R2: R2Bucket;
}

type StorageMode = "kv" | "r2";
type ObjectRole = "raw" | "text" | "html" | "attachment";

interface OperationRow {
  id: string;
  storage_mode: StorageMode;
  state: string;
  attempts: number;
  last_error: string | null;
}

interface MessageRow {
  id: string;
  operation_id: string;
  state: string;
  subject: string;
}

interface ObjectRow {
  object_key: string;
  operation_id: string;
  message_id: string | null;
  role: ObjectRole;
  generation: number;
  active: number;
  expected_size: number;
  expected_sha256: string;
  state: string;
}

interface ObjectSpec {
  key: string;
  operationId: string;
  messageId: string;
  role: ObjectRole;
  generation: number;
  bytes: Uint8Array;
  sha256: string;
}

interface StoredObject {
  bytes: Uint8Array;
}

interface ObjectStore {
  put(spec: ObjectSpec): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

class InjectedFault extends Error {
  constructor(point: string) {
    super(`注入故障：${point}`);
    this.name = "InjectedFault";
  }
}

const encoder = new TextEncoder();
const roles: ObjectRole[] = ["raw", "text", "html", "attachment"];

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

function now(): number {
  return Date.now();
}

function messageId(operationId: string): string {
  return `message-${operationId}`;
}

function objectKey(mode: StorageMode, operationId: string, role: ObjectRole, generation: number): string {
  return `mail/${mode}/${operationId}/${role}/v${generation}`;
}

function parseMode(value: string | null): StorageMode {
  if (value === "kv" || value === "r2") {
    return value;
  }
  throw new Error("storage mode 必须是 kv 或 r2");
}

function maybeFault(selected: string | null, point: string): void {
  if (selected === point) {
    throw new InjectedFault(point);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer as ArrayBuffer
    : bytes.slice().buffer;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function contentForRole(operationId: string, role: ObjectRole): Uint8Array {
  switch (role) {
    case "raw":
      return encoder.encode(
        [
          `Message-ID: <${operationId}@example.test>`,
          "From: sender@example.test",
          "To: receiver@example.test",
          `Subject: 故障恢复验证 ${operationId}`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "",
          `这是 ${operationId} 的原始合成邮件。`,
          "R".repeat(4096)
        ].join("\r\n")
      );
    case "text":
      return encoder.encode(`这是 ${operationId} 的纯文本正文。\n${"T".repeat(1024)}`);
    case "html":
      return encoder.encode(`<p>这是 <strong>${operationId}</strong> 的 HTML 正文。</p>${"H".repeat(2048)}`);
    case "attachment": {
      const bytes = new Uint8Array(8192);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = (index * 31 + operationId.length * 17) & 0xff;
      }
      return bytes;
    }
  }
}

async function buildSpec(
  mode: StorageMode,
  operationId: string,
  role: ObjectRole,
  generation = 1
): Promise<ObjectSpec> {
  const bytes = contentForRole(operationId, role);
  return {
    key: objectKey(mode, operationId, role, generation),
    operationId,
    messageId: messageId(operationId),
    role,
    generation,
    bytes,
    sha256: await sha256(bytes)
  };
}

function createStore(env: Env, mode: StorageMode): ObjectStore {
  if (mode === "r2") {
    return {
      async put(spec) {
        await env.MAIL_R2.put(spec.key, spec.bytes, {
          customMetadata: {
            operationId: spec.operationId,
            role: spec.role,
            generation: String(spec.generation),
            sha256: spec.sha256,
            size: String(spec.bytes.byteLength)
          }
        });
      },
      async get(key) {
        const object = await env.MAIL_R2.get(key);
        if (!object) {
          return null;
        }
        return { bytes: new Uint8Array(await object.arrayBuffer()) };
      },
      async delete(key) {
        await env.MAIL_R2.delete(key);
      },
      async list(prefix) {
        const keys: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await env.MAIL_R2.list({ prefix, cursor });
          keys.push(...page.objects.map((object) => object.key));
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        return keys.sort();
      }
    };
  }

  return {
    async put(spec) {
      await env.MAIL_KV.put(spec.key, toArrayBuffer(spec.bytes), {
        metadata: {
          operationId: spec.operationId,
          role: spec.role,
          generation: spec.generation,
          sha256: spec.sha256,
          size: spec.bytes.byteLength
        }
      });
    },
    async get(key) {
      const value = await env.MAIL_KV.get(key, "arrayBuffer");
      return value ? { bytes: new Uint8Array(value) } : null;
    },
    async delete(key) {
      await env.MAIL_KV.delete(key);
    },
    async list(prefix) {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await env.MAIL_KV.list({ prefix, cursor });
        keys.push(...page.keys.map((key) => key.name));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return keys.sort();
    }
  };
}

async function first<T>(statement: D1PreparedStatement): Promise<T | null> {
  return await statement.first<T>();
}

async function all<T>(statement: D1PreparedStatement): Promise<T[]> {
  const result = await statement.all<T>();
  return result.results;
}

async function insertAudit(env: Env, category: string, targetId: string, detailCode: string): Promise<void> {
  const timestamp = now();
  await env.DB.prepare(
    `INSERT INTO audit_events(category, target_id, detail_code, created_at)
     SELECT ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM audit_events WHERE category = ? AND target_id = ? AND detail_code = ?
     )`
  ).bind(category, targetId, detailCode, timestamp, category, targetId, detailCode).run();
}

async function ensureOperation(env: Env, mode: StorageMode, operationId: string): Promise<void> {
  const raw = await buildSpec(mode, operationId, "raw");
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO operations(id, storage_mode, state, created_at, updated_at)
       VALUES (?, ?, 'receiving', ?, ?)`
    ).bind(operationId, mode, timestamp, timestamp),
    env.DB.prepare(
      `INSERT OR IGNORE INTO object_registry(
         object_key, operation_id, message_id, role, generation, active,
         expected_size, expected_sha256, state, created_at, updated_at
       ) VALUES (?, ?, NULL, 'raw', 1, 1, ?, ?, 'expected', ?, ?)`
    ).bind(raw.key, operationId, raw.bytes.byteLength, raw.sha256, timestamp, timestamp),
    env.DB.prepare(
      `INSERT OR IGNORE INTO tasks(id, kind, target_id, state, created_at, updated_at)
       VALUES (?, 'receive', ?, 'pending', ?, ?)`
    ).bind(`receive-${operationId}`, operationId, timestamp, timestamp)
  ]);

  const operation = await first<OperationRow>(env.DB.prepare("SELECT * FROM operations WHERE id = ?").bind(operationId));
  if (!operation || operation.storage_mode !== mode) {
    throw new Error("同一操作编号不能切换对象存储模式");
  }
}

async function objectRow(env: Env, operationId: string, role: ObjectRole): Promise<ObjectRow | null> {
  return await first<ObjectRow>(
    env.DB.prepare(
      "SELECT * FROM object_registry WHERE operation_id = ? AND role = ? AND active = 1"
    ).bind(operationId, role)
  );
}

async function specFromRow(mode: StorageMode, row: ObjectRow): Promise<ObjectSpec> {
  const spec = await buildSpec(mode, row.operation_id, row.role, row.generation);
  if (
    spec.key !== row.object_key ||
    spec.bytes.byteLength !== row.expected_size ||
    spec.sha256 !== row.expected_sha256
  ) {
    throw new Error(`对象登记与确定性内容不一致：${row.object_key}`);
  }
  return spec;
}

async function matchesExpected(object: StoredObject | null, row: ObjectRow): Promise<boolean> {
  return Boolean(
    object &&
    object.bytes.byteLength === row.expected_size &&
    await sha256(object.bytes) === row.expected_sha256
  );
}

async function ensureObject(
  env: Env,
  store: ObjectStore,
  mode: StorageMode,
  operationId: string,
  role: ObjectRole,
  fault: string | null,
  kvConsistent: boolean
): Promise<boolean> {
  const row = await objectRow(env, operationId, role);
  if (!row) {
    throw new Error(`缺少对象登记：${operationId}/${role}`);
  }
  const spec = await specFromRow(mode, row);

  if (row.state === "present") {
    if (mode === "kv" && !kvConsistent) {
      return true;
    }
    const existing = await store.get(row.object_key);
    if (!await matchesExpected(existing, row)) {
      throw new Error(`已登记对象缺失或损坏：${row.object_key}`);
    }
    return true;
  }

  if (row.state === "writing") {
    if (mode === "kv" && !kvConsistent) {
      return false;
    }
    const existing = await store.get(row.object_key);
    if (await matchesExpected(existing, row)) {
      await env.DB.prepare(
        "UPDATE object_registry SET state = 'present', updated_at = ? WHERE object_key = ?"
      ).bind(now(), row.object_key).run();
      return true;
    }
  }

  await env.DB.prepare(
    "UPDATE object_registry SET state = 'writing', updated_at = ? WHERE object_key = ?"
  ).bind(now(), row.object_key).run();
  maybeFault(fault, role === "raw" ? "after_raw_write_intent" : "after_derived_write_intent");

  await store.put(spec);
  if (role === "raw") {
    maybeFault(fault, "after_raw_put");
  } else if (role === "text") {
    maybeFault(fault, "after_first_derived_put");
  }

  await env.DB.prepare(
    "UPDATE object_registry SET state = 'present', updated_at = ? WHERE object_key = ?"
  ).bind(now(), row.object_key).run();
  return true;
}

async function ensureMessagePlan(env: Env, mode: StorageMode, operationId: string): Promise<void> {
  const timestamp = now();
  const id = messageId(operationId);
  const derived = await Promise.all(
    roles.filter((role) => role !== "raw").map((role) => buildSpec(mode, operationId, role))
  );
  const statements = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO messages(id, operation_id, state, subject, created_at, updated_at)
       VALUES (?, ?, 'preparing', ?, ?, ?)`
    ).bind(id, operationId, `故障恢复验证 ${operationId}`, timestamp, timestamp),
    env.DB.prepare(
      `INSERT OR IGNORE INTO tasks(id, kind, target_id, state, created_at, updated_at)
       VALUES (?, 'parse', ?, 'pending', ?, ?)`
    ).bind(`parse-${operationId}`, operationId, timestamp, timestamp),
    env.DB.prepare(
      "UPDATE operations SET state = 'parsing', updated_at = ? WHERE id = ?"
    ).bind(timestamp, operationId)
  ];

  for (const spec of derived) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO object_registry(
           object_key, operation_id, message_id, role, generation, active,
           expected_size, expected_sha256, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, 'expected', ?, ?)`
      ).bind(
        spec.key,
        operationId,
        id,
        spec.role,
        spec.bytes.byteLength,
        spec.sha256,
        timestamp,
        timestamp
      )
    );
  }
  await env.DB.batch(statements);
}

async function verifyActiveObjects(
  env: Env,
  store: ObjectStore,
  operationId: string,
  mode: StorageMode,
  kvConsistent: boolean
): Promise<boolean> {
  if (mode === "kv" && !kvConsistent) {
    return false;
  }
  const rows = await all<ObjectRow>(
    env.DB.prepare(
      "SELECT * FROM object_registry WHERE operation_id = ? AND active = 1 ORDER BY role"
    ).bind(operationId)
  );
  if (rows.length !== roles.length) {
    return false;
  }
  for (const row of rows) {
    if (row.state !== "present" || !await matchesExpected(await store.get(row.object_key), row)) {
      return false;
    }
  }
  return true;
}

async function commitVisibility(
  env: Env,
  operationId: string,
  fault: string | null
): Promise<void> {
  const id = messageId(operationId);
  const timestamp = now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO mailbox_entries(id, message_id, user_id, created_at)
       VALUES (?, ?, 'user-1', ?)`
    ).bind(`mailbox-${operationId}`, id, timestamp),
    env.DB.prepare("UPDATE messages SET state = 'visible', updated_at = ? WHERE id = ?")
      .bind(timestamp, id),
    env.DB.prepare("UPDATE operations SET state = 'completed', last_error = NULL, updated_at = ? WHERE id = ?")
      .bind(timestamp, operationId),
    env.DB.prepare("UPDATE tasks SET state = 'completed', last_error = NULL, updated_at = ? WHERE id = ?")
      .bind(timestamp, `parse-${operationId}`)
  ];
  if (fault === "visibility_batch_rollback") {
    statements.splice(2, 0, env.DB.prepare("INSERT INTO missing_visibility_table(value) VALUES (1)"));
  }
  await env.DB.batch(statements);
  await insertAudit(env, "receive", operationId, "message-visible");
  maybeFault(fault, "after_visibility_commit");
}

async function processIngest(
  env: Env,
  mode: StorageMode,
  operationId: string,
  fault: string | null,
  kvConsistent: boolean
): Promise<Record<string, unknown>> {
  const store = createStore(env, mode);
  await ensureOperation(env, mode, operationId);
  maybeFault(fault, "after_operation_created");

  const rawReady = await ensureObject(
    env,
    store,
    mode,
    operationId,
    "raw",
    fault,
    kvConsistent
  );
  if (!rawReady) {
    await env.DB.prepare(
      "UPDATE operations SET state = 'waiting_consistency', updated_at = ? WHERE id = ?"
    ).bind(now(), operationId).run();
    return { outcome: "waiting-consistency", stage: "raw" };
  }

  await ensureMessagePlan(env, mode, operationId);
  for (const role of roles.filter((item) => item !== "raw")) {
    const ready = await ensureObject(env, store, mode, operationId, role, fault, kvConsistent);
    if (!ready) {
      return { outcome: "waiting-consistency", stage: role };
    }
  }

  if (!await verifyActiveObjects(env, store, operationId, mode, kvConsistent)) {
    await env.DB.batch([
      env.DB.prepare("UPDATE messages SET state = 'stabilizing', updated_at = ? WHERE operation_id = ?")
        .bind(now(), operationId),
      env.DB.prepare(
        "UPDATE tasks SET state = 'waiting_consistency', updated_at = ? WHERE id = ?"
      ).bind(now(), `parse-${operationId}`)
    ]);
    return { outcome: "waiting-consistency", stage: "visibility" };
  }

  await commitVisibility(env, operationId, fault);
  return { outcome: "visible" };
}

async function snapshot(env: Env, mode: StorageMode, operationId: string): Promise<Record<string, unknown>> {
  const store = createStore(env, mode);
  const operation = await first<OperationRow>(
    env.DB.prepare("SELECT * FROM operations WHERE id = ?").bind(operationId)
  );
  const message = await first<MessageRow>(
    env.DB.prepare("SELECT * FROM messages WHERE operation_id = ?").bind(operationId)
  );
  const objects = await all<ObjectRow>(
    env.DB.prepare("SELECT * FROM object_registry WHERE operation_id = ? ORDER BY role, generation")
      .bind(operationId)
  );
  const mailboxCount = await first<{ count: number }>(
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM mailbox_entries e
       JOIN messages m ON m.id = e.message_id
       WHERE m.operation_id = ? AND m.state = 'visible'`
    ).bind(operationId)
  );
  const taskCount = await first<{ count: number }>(
    env.DB.prepare("SELECT COUNT(*) AS count FROM tasks WHERE target_id = ?").bind(operationId)
  );
  const auditCount = await first<{ count: number }>(
    env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE target_id = ?").bind(operationId)
  );
  return {
    operation,
    message,
    mailboxCount: mailboxCount?.count ?? 0,
    registryCount: objects.length,
    activeRegistryCount: objects.filter((object) => object.active === 1).length,
    objectStates: objects.map((object) => ({
      key: object.object_key,
      role: object.role,
      generation: object.generation,
      active: object.active,
      state: object.state
    })),
    actualKeys: await store.list(`mail/${mode}/${operationId}/`),
    taskCount: taskCount?.count ?? 0,
    auditCount: auditCount?.count ?? 0
  };
}

async function auditObjects(env: Env, mode: StorageMode, operationId?: string): Promise<Record<string, unknown>> {
  const store = createStore(env, mode);
  const prefix = operationId ? `mail/${mode}/${operationId}/` : `mail/${mode}/`;
  const registry = operationId
    ? await all<ObjectRow>(env.DB.prepare("SELECT * FROM object_registry WHERE operation_id = ?").bind(operationId))
    : await all<ObjectRow>(
        env.DB.prepare(
          `SELECT r.* FROM object_registry r
           JOIN operations o ON o.id = r.operation_id
           WHERE o.storage_mode = ?`
        ).bind(mode)
      );
  const actualKeys = await store.list(prefix);
  const registryByKey = new Map(registry.map((row) => [row.object_key, row]));
  const actualSet = new Set(actualKeys);
  const missing: string[] = [];
  const damaged: string[] = [];

  for (const row of registry.filter((item) => item.active === 1 && item.state === "present")) {
    const object = actualSet.has(row.object_key) ? await store.get(row.object_key) : null;
    if (!object) {
      missing.push(row.object_key);
    } else if (!await matchesExpected(object, row)) {
      damaged.push(row.object_key);
    }
  }

  const orphaned = actualKeys.filter((key) => !registryByKey.has(key));
  return {
    registryCount: registry.length,
    activePresentCount: registry.filter((item) => item.active === 1 && item.state === "present").length,
    actualCount: actualKeys.length,
    missing,
    damaged,
    orphaned,
    healthy: missing.length === 0 && damaged.length === 0 && orphaned.length === 0
  };
}

async function hideAndPrepareRepair(
  env: Env,
  mode: StorageMode,
  operationId: string
): Promise<Record<string, unknown>> {
  const store = createStore(env, mode);
  const audit = await auditObjects(env, mode, operationId) as {
    missing: string[];
    damaged: string[];
  };
  const badKeys = [...audit.missing, ...audit.damaged];
  if (badKeys.length === 0) {
    return { outcome: "healthy" };
  }

  const badRows = await all<ObjectRow>(
    env.DB.prepare(
      `SELECT * FROM object_registry
       WHERE operation_id = ? AND active = 1 AND object_key IN (${badKeys.map(() => "?").join(",")})`
    ).bind(operationId, ...badKeys)
  );
  if (badRows.some((row) => row.role === "raw")) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM mailbox_entries WHERE message_id = ?").bind(messageId(operationId)),
      env.DB.prepare("UPDATE messages SET state = 'damaged', updated_at = ? WHERE operation_id = ?")
        .bind(now(), operationId),
      env.DB.prepare("UPDATE tasks SET state = 'failed', last_error = 'raw-object-lost', updated_at = ? WHERE id = ?")
        .bind(now(), `parse-${operationId}`)
    ]);
    await insertAudit(env, "integrity", operationId, "raw-object-lost");
    return { outcome: "damaged", reason: "raw-object-lost" };
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM mailbox_entries WHERE message_id = ?").bind(messageId(operationId)),
    env.DB.prepare("UPDATE messages SET state = 'repairing', updated_at = ? WHERE operation_id = ?")
      .bind(now(), operationId),
    env.DB.prepare("UPDATE tasks SET state = 'pending', last_error = 'derived-object-repair', updated_at = ? WHERE id = ?")
      .bind(now(), `parse-${operationId}`)
  ]);

  for (const row of badRows) {
    const generation = row.generation + 1;
    const spec = await buildSpec(mode, operationId, row.role, generation);
    const timestamp = now();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE object_registry SET active = 0, state = 'delete_pending', updated_at = ? WHERE object_key = ?"
      ).bind(timestamp, row.object_key),
      env.DB.prepare(
        `INSERT INTO object_registry(
           object_key, operation_id, message_id, role, generation, active,
           expected_size, expected_sha256, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'expected', ?, ?)`
      ).bind(
        spec.key,
        operationId,
        messageId(operationId),
        spec.role,
        generation,
        spec.bytes.byteLength,
        spec.sha256,
        timestamp,
        timestamp
      )
    ]);
    await store.delete(row.object_key);
    await env.DB.prepare("DELETE FROM object_registry WHERE object_key = ?").bind(row.object_key).run();
  }
  await insertAudit(env, "integrity", operationId, "derived-object-repair-started");
  return { outcome: "repairing", roles: badRows.map((row) => row.role) };
}

async function beginDelete(
  env: Env,
  mode: StorageMode,
  operationId: string,
  fault: string | null
): Promise<Record<string, unknown>> {
  const operation = await first<OperationRow>(
    env.DB.prepare("SELECT * FROM operations WHERE id = ?").bind(operationId)
  );
  if (!operation) {
    throw new Error("找不到删除目标");
  }
  if (operation.state === "deleted") {
    return { outcome: "deleted" };
  }

  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mailbox_entries WHERE message_id = ?").bind(messageId(operationId)),
    env.DB.prepare("UPDATE messages SET state = 'delete_pending', updated_at = ? WHERE operation_id = ?")
      .bind(timestamp, operationId),
    env.DB.prepare(
      "UPDATE object_registry SET state = 'delete_pending', updated_at = ? WHERE operation_id = ?"
    ).bind(timestamp, operationId),
    env.DB.prepare("UPDATE operations SET state = 'delete_pending', updated_at = ? WHERE id = ?")
      .bind(timestamp, operationId),
    env.DB.prepare(
      `INSERT INTO tasks(id, kind, target_id, state, created_at, updated_at)
       VALUES (?, 'delete', ?, 'pending', ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = 'pending', updated_at = excluded.updated_at`
    ).bind(`delete-${operationId}`, operationId, timestamp, timestamp)
  ]);
  await insertAudit(env, "delete", operationId, "access-revoked");
  maybeFault(fault, "after_delete_tombstone");

  const store = createStore(env, mode);
  const objectRows = await all<ObjectRow>(
    env.DB.prepare("SELECT * FROM object_registry WHERE operation_id = ? ORDER BY object_key")
      .bind(operationId)
  );
  for (let index = 0; index < objectRows.length; index += 1) {
    const row = objectRows[index];
    await store.delete(row.object_key);
    if (index === 0) {
      maybeFault(fault, "after_first_object_delete");
    }
    await env.DB.prepare(
      "UPDATE object_registry SET state = 'deleted', updated_at = ? WHERE object_key = ?"
    ).bind(now(), row.object_key).run();
  }

  const finalStatements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM object_registry WHERE operation_id = ?").bind(operationId),
    env.DB.prepare("DELETE FROM messages WHERE operation_id = ?").bind(operationId),
    env.DB.prepare("UPDATE operations SET state = 'deleted', last_error = NULL, updated_at = ? WHERE id = ?")
      .bind(now(), operationId),
    env.DB.prepare("UPDATE tasks SET state = 'completed', last_error = NULL, updated_at = ? WHERE id = ?")
      .bind(now(), `delete-${operationId}`)
  ];
  if (fault === "delete_batch_rollback") {
    finalStatements.splice(2, 0, env.DB.prepare("INSERT INTO missing_delete_table(value) VALUES (1)"));
  }
  await env.DB.batch(finalStatements);
  await insertAudit(env, "delete", operationId, "physical-delete-completed");
  maybeFault(fault, "after_delete_commit");
  return { outcome: "deleted" };
}

async function reset(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mailbox_entries"),
    env.DB.prepare("DELETE FROM object_registry"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM tasks"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("DELETE FROM operations")
  ]);
  for (const mode of ["kv", "r2"] as const) {
    const store = createStore(env, mode);
    for (const key of await store.list(`mail/${mode}/`)) {
      await store.delete(key);
    }
  }
}

async function corrupt(
  env: Env,
  mode: StorageMode,
  operationId: string,
  action: string,
  role: ObjectRole
): Promise<Record<string, unknown>> {
  const store = createStore(env, mode);
  if (action === "orphan") {
    const spec = await buildSpec(mode, `orphan-${operationId}`, "attachment");
    const orphanSpec = { ...spec, key: `mail/${mode}/${operationId}/orphan/v1` };
    await store.put(orphanSpec);
    return { outcome: "orphan-created", key: orphanSpec.key };
  }
  const row = await objectRow(env, operationId, role);
  if (!row) {
    throw new Error("找不到待破坏对象");
  }
  if (action === "delete") {
    await store.delete(row.object_key);
    return { outcome: "object-deleted", key: row.object_key };
  }
  if (action === "damage") {
    const spec = await specFromRow(mode, row);
    await store.put({ ...spec, bytes: encoder.encode("损坏内容"), sha256: await sha256(encoder.encode("损坏内容")) });
    return { outcome: "object-damaged", key: row.object_key };
  }
  if (action === "cleanup-orphans") {
    const audit = await auditObjects(env, mode, operationId) as { orphaned: string[] };
    for (const key of audit.orphaned) {
      await store.delete(key);
    }
    return { outcome: "orphans-cleaned", count: audit.orphaned.length };
  }
  throw new Error("未知破坏动作");
}

async function contentAccess(
  env: Env,
  mode: StorageMode,
  operationId: string,
  role: ObjectRole
): Promise<Response> {
  const allowed = await first<{ object_key: string }>(
    env.DB.prepare(
      `SELECT r.object_key
       FROM mailbox_entries e
       JOIN messages m ON m.id = e.message_id AND m.state = 'visible'
       JOIN object_registry r ON r.message_id = m.id AND r.role = ? AND r.active = 1 AND r.state = 'present'
       WHERE m.operation_id = ? AND e.user_id = 'user-1'`
    ).bind(role, operationId)
  );
  if (!allowed) {
    return json({ error: "对象不可访问" }, 404);
  }
  const object = await createStore(env, mode).get(allowed.object_key);
  if (!object) {
    return json({ error: "对象暂时不可用" }, 503);
  }
  return json({ size: object.bytes.byteLength, sha256: await sha256(object.bytes) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true });
    }
    if (request.method !== "POST") {
      return json({ error: "仅接受 POST" }, 405);
    }

    try {
      if (url.pathname === "/reset") {
        await reset(env);
        return json({ ok: true });
      }

      const mode = parseMode(url.searchParams.get("mode"));
      const operationId = url.searchParams.get("operation") ?? "operation-default";
      const fault = url.searchParams.get("fault");
      const kvConsistent = url.searchParams.get("kvConsistent") === "true";

      if (url.pathname === "/ingest" || url.pathname === "/repair") {
        const result = await processIngest(env, mode, operationId, fault, kvConsistent);
        return json({ ...result, snapshot: await snapshot(env, mode, operationId) });
      }
      if (url.pathname === "/snapshot") {
        return json(await snapshot(env, mode, operationId));
      }
      if (url.pathname === "/audit") {
        return json(await auditObjects(env, mode, operationId));
      }
      if (url.pathname === "/reconcile") {
        return json(await hideAndPrepareRepair(env, mode, operationId));
      }
      if (url.pathname === "/delete") {
        const result = await beginDelete(env, mode, operationId, fault);
        return json({ ...result, snapshot: await snapshot(env, mode, operationId) });
      }
      if (url.pathname === "/corrupt") {
        const action = url.searchParams.get("action") ?? "delete";
        const role = (url.searchParams.get("role") ?? "text") as ObjectRole;
        return json(await corrupt(env, mode, operationId, action, role));
      }
      if (url.pathname === "/content") {
        const role = (url.searchParams.get("role") ?? "text") as ObjectRole;
        return await contentAccess(env, mode, operationId, role);
      }
      return json({ error: "未找到原型接口" }, 404);
    } catch (error) {
      const operationId = url.searchParams.get("operation");
      if (operationId) {
        await env.DB.prepare(
          `UPDATE operations
           SET attempts = attempts + 1, last_error = ?, updated_at = ?
           WHERE id = ?`
        ).bind(error instanceof Error ? error.message : String(error), now(), operationId).run();
      }
      return json(
        {
          success: false,
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error)
        },
        error instanceof InjectedFault ? 503 : 500
      );
    }
  }
} satisfies ExportedHandler<Env>;
