import { and, desc, eq, gt, inArray, lt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { addresses, mailboxEntries, messages, users } from "./数据库结构";

interface Env {
  DB: D1Database;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function chunksOf<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function seed(env: Env): Promise<Response> {
  const db = drizzle(env.DB);
  const now = 1_800_000_000_000;
  await db.batch([
    db.insert(users).values([
      { id: "user-owner", email: "owner@example.test", status: "active", createdAt: now },
      { id: "user-other", email: "other@example.test", status: "active", createdAt: now + 1 }
    ]),
    db.insert(addresses).values([
      {
        id: "address-owner",
        address: "owner@example.test",
        ownerUserId: "user-owner",
        kind: "primary",
        createdAt: now
      },
      {
        id: "address-alias",
        address: "alias@example.test",
        ownerUserId: "user-owner",
        kind: "alias",
        createdAt: now + 1
      },
      {
        id: "address-other",
        address: "other@example.test",
        ownerUserId: "user-other",
        kind: "primary",
        createdAt: now + 2
      }
    ])
  ]);

  const statements: D1PreparedStatement[] = [];
  const ownerEntryIds: string[] = [];
  for (let index = 0; index < 205; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const messageId = `message-${suffix}`;
    const entryId = `entry-${suffix}`;
    ownerEntryIds.push(entryId);
    statements.push(
      env.DB.prepare(
        `INSERT INTO messages
          (id, sender, subject, preview_text, received_at, has_attachments, visibility, object_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        messageId,
        index % 2 === 0 ? "family@example.net" : "team@example.net",
        index % 3 === 0 ? `项目预算 ${suffix}` : `家庭通知 ${suffix}`,
        index % 3 === 0 ? "预算调整摘要" : "普通通知摘要",
        now - index * 1000,
        index % 5 === 0 ? 1 : 0,
        index === 204 ? "staging" : "visible",
        `objects/${messageId}`
      ),
      env.DB.prepare(
        `INSERT INTO mailbox_entries
          (id, user_id, message_id, delivered_address_id, mailbox, is_read, is_starred, is_archived, created_at)
         VALUES (?, 'user-owner', ?, ?, ?, ?, 0, 0, ?)`
      ).bind(
        entryId,
        messageId,
        index % 2 === 0 ? "address-owner" : "address-alias",
        index % 10 === 0 ? "trash" : "inbox",
        index % 4 === 0 ? 0 : 1,
        now - index * 1000
      )
    );
  }
  for (const statementChunk of chunksOf(statements, 50)) {
    await env.DB.batch(statementChunk);
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO mailbox_entries
        (id, user_id, message_id, delivered_address_id, mailbox, is_read, is_starred, is_archived, created_at)
       VALUES ('other-entry', 'user-other', 'message-000', 'address-other', 'inbox', 0, 0, 0, ?)`
    ).bind(now)
  ]);

  for (let index = 0; index < 12; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const inserted = await env.DB.prepare(
      "INSERT INTO search_chunks (message_id, scope_id, chunk_index) VALUES (?, 'user-owner', 0) RETURNING id"
    ).bind(`message-${suffix}`).first<{ id: number }>();
    if (!inserted) throw new Error("无法建立搜索映射");
    await env.DB.prepare(
      "INSERT INTO message_search (rowid, scope_token, subject_tokens, body_tokens) VALUES (?, ?, ?, ?)"
    ).bind(
      inserted.id,
      "scope_user_owner",
      index % 3 === 0 ? "项目 预算" : "家庭 通知",
      index % 3 === 0 ? "预算 调整" : "普通 通知"
    ).run();
  }

  return json({ seeded: true, ownerEntryIds });
}

function listFilters(url: URL) {
  return {
    userId: url.searchParams.get("user") ?? "user-owner",
    addressId: url.searchParams.get("address"),
    unreadOnly: url.searchParams.get("unread") === "1",
    attachmentsOnly: url.searchParams.get("attachments") === "1",
    beforeReceivedAt: url.searchParams.has("beforeReceivedAt")
      ? Number(url.searchParams.get("beforeReceivedAt"))
      : null,
    beforeId: url.searchParams.get("beforeId"),
    limit: Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 20)))
  };
}

async function drizzleList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const filters = listFilters(url);
  const conditions = [
    eq(mailboxEntries.userId, filters.userId),
    eq(mailboxEntries.mailbox, "inbox"),
    eq(messages.visibility, "visible")
  ];
  if (filters.addressId) conditions.push(eq(mailboxEntries.deliveredAddressId, filters.addressId));
  if (filters.unreadOnly) conditions.push(eq(mailboxEntries.isRead, false));
  if (filters.attachmentsOnly) conditions.push(eq(messages.hasAttachments, true));
  if (filters.beforeReceivedAt !== null && filters.beforeId) {
    conditions.push(
      or(
        lt(messages.receivedAt, filters.beforeReceivedAt),
        and(eq(messages.receivedAt, filters.beforeReceivedAt), lt(messages.id, filters.beforeId))
      )!
    );
  }
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      entryId: mailboxEntries.id,
      messageId: messages.id,
      subject: messages.subject,
      previewText: messages.previewText,
      receivedAt: messages.receivedAt,
      isRead: mailboxEntries.isRead,
      hasAttachments: messages.hasAttachments,
      deliveredAddress: addresses.address
    })
    .from(mailboxEntries)
    .innerJoin(messages, eq(messages.id, mailboxEntries.messageId))
    .innerJoin(addresses, eq(addresses.id, mailboxEntries.deliveredAddressId))
    .where(and(...conditions))
    .orderBy(desc(messages.receivedAt), desc(messages.id))
    .limit(filters.limit);
  return json({ rows });
}

async function rawList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const filters = listFilters(url);
  const clauses = [
    "e.user_id = ?",
    "e.mailbox = 'inbox'",
    "m.visibility = 'visible'"
  ];
  const bindings: unknown[] = [filters.userId];
  if (filters.addressId) {
    clauses.push("e.delivered_address_id = ?");
    bindings.push(filters.addressId);
  }
  if (filters.unreadOnly) clauses.push("e.is_read = 0");
  if (filters.attachmentsOnly) clauses.push("m.has_attachments = 1");
  if (filters.beforeReceivedAt !== null && filters.beforeId) {
    clauses.push("(m.received_at < ? OR (m.received_at = ? AND m.id < ?))");
    bindings.push(filters.beforeReceivedAt, filters.beforeReceivedAt, filters.beforeId);
  }
  bindings.push(filters.limit);
  const result = await env.DB.prepare(
    `SELECT
       e.id AS entryId,
       m.id AS messageId,
       m.subject,
       m.preview_text AS previewText,
       m.received_at AS receivedAt,
       e.is_read AS isRead,
       m.has_attachments AS hasAttachments,
       a.address AS deliveredAddress
     FROM mailbox_entries e
     JOIN messages m ON m.id = e.message_id
     JOIN addresses a ON a.id = e.delivered_address_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY m.received_at DESC, m.id DESC
     LIMIT ?`
  ).bind(...bindings).all();
  return json({ rows: result.results, meta: result.meta });
}

function searchExpression(term: string): string {
  const compact = Array.from(term.normalize("NFKC").replaceAll(/[\p{P}\p{S}\s]+/gu, ""));
  if (compact.length < 2) return "";
  const tokens = [];
  for (let index = 0; index < compact.length - 1; index += 1) {
    tokens.push(`${compact[index]}${compact[index + 1]}`);
  }
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
}

function indexTokens(value: string): string {
  const characters = Array.from(value.normalize("NFKC").replaceAll(/[\p{P}\p{S}\s]+/gu, ""));
  const tokens = [];
  for (let index = 0; index < characters.length - 1; index += 1) {
    tokens.push(`${characters[index]}${characters[index + 1]}`);
  }
  return tokens.join(" ");
}

async function search(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const expression = searchExpression(url.searchParams.get("term") ?? "");
  if (!expression) return json({ error: "搜索词至少需要两个字符" }, 400);
  const scopeId = url.searchParams.get("scope") ?? "user-owner";
  const result = await env.DB.prepare(
    `SELECT sc.message_id
     FROM message_search
     JOIN search_chunks sc ON sc.id = message_search.rowid
     WHERE message_search MATCH ? AND sc.scope_id = ?
     ORDER BY sc.message_id
     LIMIT 50`
  ).bind(expression, scopeId).all();
  return json({ expression, messageIds: result.results.map((row) => row.message_id), meta: result.meta });
}

async function batchFailure(env: Env): Promise<Response> {
  const db = drizzle(env.DB);
  let rejected = false;
  try {
    await db.batch([
      db.insert(messages).values({
        id: "batch-failure-message",
        sender: "sender@example.net",
        subject: "批处理失败验证",
        previewText: "不应保留",
        receivedAt: Date.now(),
        hasAttachments: false,
        visibility: "visible",
        objectKey: "objects/batch-failure-message"
      }),
      db.insert(mailboxEntries).values({
        id: "batch-failure-entry",
        userId: "user-owner",
        messageId: "batch-failure-message",
        deliveredAddressId: "address-owner",
        mailbox: "inbox",
        isRead: false,
        isStarred: false,
        isArchived: false,
        createdAt: Date.now()
      }),
      db.insert(mailboxEntries).values({
        id: "batch-failure-entry",
        userId: "user-owner",
        messageId: "batch-failure-message",
        deliveredAddressId: "address-alias",
        mailbox: "inbox",
        isRead: false,
        isStarred: false,
        isArchived: false,
        createdAt: Date.now()
      })
    ]);
  } catch {
    rejected = true;
  }
  const messageCount = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM messages WHERE id = 'batch-failure-message'"
  ).first<{ count: number }>();
  const entryCount = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM mailbox_entries WHERE id = 'batch-failure-entry'"
  ).first<{ count: number }>();
  return json({ rejected, messageCount: messageCount?.count ?? -1, entryCount: entryCount?.count ?? -1 });
}

async function chunkUpdate(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ ids: string[] }>();
  const chunks = chunksOf(body.ids, 90);
  let changes = 0;
  for (const idChunk of chunks) {
    const placeholders = idChunk.map(() => "?").join(", ");
    const result = await env.DB.prepare(
      `UPDATE mailbox_entries SET is_starred = 1 WHERE user_id = ? AND id IN (${placeholders})`
    ).bind("user-owner", ...idChunk).run();
    changes += result.meta.changes;
  }
  return json({ chunkSizes: chunks.map((chunk) => chunk.length), changes });
}

async function schemaCheck(env: Env): Promise<Response> {
  const foreignKeyCheck = await env.DB.prepare("PRAGMA foreign_key_check").all();
  const messageColumns = await env.DB.prepare("PRAGMA table_info(messages)").all();
  const objects = await env.DB.prepare(
    `SELECT name, type FROM sqlite_master
     WHERE name IN ('users', 'addresses', 'messages', 'mailbox_entries', 'search_chunks', 'message_search')
     ORDER BY name`
  ).all();
  const upgradeRow = await env.DB.prepare(
    "SELECT preview_text FROM messages WHERE id = 'pre-message'"
  ).first<{ preview_text: string }>();
  const migrations = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all();
  const marker = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'migration_partial_marker'"
  ).first<{ count: number }>();
  return json({
    foreignKeyViolations: foreignKeyCheck.results,
    messageColumns: messageColumns.results,
    objects: objects.results,
    upgradePreviewText: upgradeRow?.preview_text,
    migrations: migrations.results,
    failedMigrationMarkerExists: (marker?.count ?? 0) > 0
  });
}

async function counts(env: Env): Promise<Response> {
  const [userCount, messageCount, entryCount, searchCount] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS count FROM users"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM messages"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM mailbox_entries"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM search_chunks")
  ]);
  const readCount = (result: D1Result<unknown>) => Number((result.results[0] as { count?: number })?.count ?? 0);
  return json({
    users: readCount(userCount),
    messages: readCount(messageCount),
    entries: readCount(entryCount),
    searchChunks: readCount(searchCount)
  });
}

async function logicalBackup(env: Env): Promise<Response> {
  const [userRows, addressRows, messageRows, entryRows, migrationRows] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM users ORDER BY id"),
    env.DB.prepare("SELECT * FROM addresses ORDER BY id"),
    env.DB.prepare("SELECT * FROM messages ORDER BY id"),
    env.DB.prepare("SELECT * FROM mailbox_entries ORDER BY id"),
    env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id")
  ]);
  return json({
    formatVersion: 1,
    migrations: migrationRows.results.map((row) => (row as { name: string }).name),
    authoritativeTables: {
      users: userRows.results,
      addresses: addressRows.results,
      messages: messageRows.results,
      mailboxEntries: entryRows.results
    },
    excludedDerivedData: ["search_chunks", "message_search"]
  });
}

async function logicalRestore(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{
    formatVersion: number;
    authoritativeTables: {
      users: Record<string, unknown>[];
      addresses: Record<string, unknown>[];
      messages: Record<string, unknown>[];
      mailboxEntries: Record<string, unknown>[];
    };
  }>();
  if (body.formatVersion !== 1) return json({ error: "不支持的备份格式" }, 400);
  const statements: D1PreparedStatement[] = [];
  for (const row of body.authoritativeTables.users) {
    statements.push(env.DB.prepare(
      "INSERT INTO users (id, email, status, created_at) VALUES (?, ?, ?, ?)"
    ).bind(row.id, row.email, row.status, row.created_at));
  }
  for (const row of body.authoritativeTables.addresses) {
    statements.push(env.DB.prepare(
      "INSERT INTO addresses (id, address, owner_user_id, kind, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(row.id, row.address, row.owner_user_id, row.kind, row.created_at));
  }
  for (const row of body.authoritativeTables.messages) {
    statements.push(env.DB.prepare(
      `INSERT INTO messages
        (id, sender, subject, preview_text, received_at, has_attachments, visibility, object_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      row.id,
      row.sender,
      row.subject,
      row.preview_text,
      row.received_at,
      row.has_attachments,
      row.visibility,
      row.object_key
    ));
  }
  for (const row of body.authoritativeTables.mailboxEntries) {
    statements.push(env.DB.prepare(
      `INSERT INTO mailbox_entries
        (id, user_id, message_id, delivered_address_id, mailbox, is_read, is_starred, is_archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      row.id,
      row.user_id,
      row.message_id,
      row.delivered_address_id,
      row.mailbox,
      row.is_read,
      row.is_starred,
      row.is_archived,
      row.created_at
    ));
  }
  for (const statementChunk of chunksOf(statements, 50)) {
    await env.DB.batch(statementChunk);
  }
  return json({ restored: true, statementCount: statements.length });
}

async function rebuildSearch(env: Env): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO message_search(message_search) VALUES('delete-all')"),
    env.DB.prepare("DELETE FROM search_chunks")
  ]);
  const rows = await env.DB.prepare(
    `SELECT DISTINCT e.user_id, m.id AS message_id, m.subject, m.preview_text
     FROM mailbox_entries e
     JOIN messages m ON m.id = e.message_id
     WHERE m.visibility = 'visible'
     ORDER BY e.user_id, m.id`
  ).all<{ user_id: string; message_id: string; subject: string; preview_text: string }>();
  let rebuilt = 0;
  for (const row of rows.results) {
    const inserted = await env.DB.prepare(
      "INSERT INTO search_chunks (message_id, scope_id, chunk_index) VALUES (?, ?, 0) RETURNING id"
    ).bind(row.message_id, row.user_id).first<{ id: number }>();
    if (!inserted) throw new Error("无法重建搜索映射");
    await env.DB.prepare(
      "INSERT INTO message_search (rowid, scope_token, subject_tokens, body_tokens) VALUES (?, ?, ?, ?)"
    ).bind(
      inserted.id,
      `scope_${row.user_id.replaceAll("-", "_")}`,
      indexTokens(row.subject),
      indexTokens(row.preview_text)
    ).run();
    rebuilt += 1;
  }
  return json({ rebuilt });
}

async function fetchHandler(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return json({ healthy: true, candidate: "drizzle" });
  if (request.method === "POST" && url.pathname === "/seed") return await seed(env);
  if (request.method === "GET" && url.pathname === "/list/drizzle") return await drizzleList(request, env);
  if (request.method === "GET" && url.pathname === "/list/raw") return await rawList(request, env);
  if (request.method === "GET" && url.pathname === "/search") return await search(request, env);
  if (request.method === "POST" && url.pathname === "/batch-failure") return await batchFailure(env);
  if (request.method === "POST" && url.pathname === "/chunk-update") return await chunkUpdate(request, env);
  if (request.method === "GET" && url.pathname === "/schema-check") return await schemaCheck(env);
  if (request.method === "GET" && url.pathname === "/counts") return await counts(env);
  if (request.method === "GET" && url.pathname === "/backup-logical") return await logicalBackup(env);
  if (request.method === "POST" && url.pathname === "/restore-logical") return await logicalRestore(request, env);
  if (request.method === "POST" && url.pathname === "/rebuild-search") return await rebuildSearch(env);
  return json({ error: "未找到" }, 404);
}

export default { fetch: fetchHandler } satisfies ExportedHandler<Env>;
