interface Env {
  DB: D1Database;
  PROTOTYPE_RESEND_SIGNING_SECRET: string;
  PROTOTYPE_SMTP2GO_USERNAME: string;
  PROTOTYPE_SMTP2GO_PASSWORD: string;
  PROTOTYPE_QUEUE_SECRET: string;
}

type Provider = "cloudflare" | "resend" | "smtp2go";
type CloudflareRecipientMode = "external" | "verified-targets";
type DeliveryState =
  | "pending"
  | "submitting"
  | "submitted"
  | "delayed"
  | "delivered"
  | "bounced"
  | "failed"
  | "unknown";

interface OperationRow {
  id: string;
  provider: Provider;
  state: DeliveryState;
  mime_size: number;
  effective_limit: number;
  provider_message_id: string | null;
  idempotency_key: string | null;
  payload_hash: string;
  attempts: number;
  last_error: string | null;
}

interface RecipientRow {
  operation_id: string;
  recipient: string;
  state: DeliveryState;
  provider_event_at: number | null;
  complaint: number;
  detail_code: string | null;
}

interface MockDeliveryRow {
  provider_message_id: string;
  payload_hash: string;
}

interface ProviderEventInput {
  id: string;
  operationId: string;
  recipient: string;
  type: string;
  occurredAt: number;
  detailCode?: string;
}

interface NormalizedEvent {
  state: DeliveryState | null;
  complaint: boolean;
}

const SIMLETTRA_LIMIT = 20_000_000;
const CLOUDFLARE_EXTERNAL_LIMIT = 5 * 1024 * 1024;
const CLOUDFLARE_VERIFIED_TARGET_LIMIT = 25 * 1024 * 1024;
const RESEND_LIMIT = 40_000_000;
const SMTP2GO_LIMIT = 50_000_000;
const RESEND_SIGNATURE_WINDOW_SECONDS = 5 * 60;
const encoder = new TextEncoder();

const providerCapabilities = {
  cloudflare: {
    provider: "cloudflare",
    displayName: "Cloudflare Email Sending",
    providerLimits: {
      external: CLOUDFLARE_EXTERNAL_LIMIT,
      verifiedTargets: CLOUDFLARE_VERIFIED_TARGET_LIMIT
    },
    idempotency: "none",
    eventTransport: "cloudflare-queue"
  },
  resend: {
    provider: "resend",
    displayName: "Resend",
    providerLimits: { allRecipients: RESEND_LIMIT },
    idempotency: "idempotency-key-24-hours",
    eventTransport: "svix-webhook"
  },
  smtp2go: {
    provider: "smtp2go",
    displayName: "SMTP2GO",
    providerLimits: { api: SMTP2GO_LIMIT },
    idempotency: "none",
    eventTransport: "basic-auth-webhook"
  }
} as const;

const stateRank: Record<DeliveryState, number> = {
  pending: 0,
  submitting: 1,
  submitted: 2,
  delayed: 3,
  unknown: 4,
  delivered: 10,
  bounced: 10,
  failed: 10
};

const terminalStates = new Set<DeliveryState>(["delivered", "bounced", "failed"]);

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

function now(): number {
  return Date.now();
}

function parseProvider(value: string | null): Provider {
  if (value === "cloudflare" || value === "resend" || value === "smtp2go") {
    return value;
  }
  throw new Error("x-provider 必须是 cloudflare、resend 或 smtp2go");
}

function parseRecipients(value: string | null): string[] {
  const recipients = (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (recipients.length === 0) {
    throw new Error("x-recipients 至少包含一个收件人");
  }
  return [...new Set(recipients)];
}

function effectiveLimit(provider: Provider, recipientMode: CloudflareRecipientMode): number {
  if (provider === "cloudflare") {
    const providerLimit = recipientMode === "verified-targets"
      ? CLOUDFLARE_VERIFIED_TARGET_LIMIT
      : CLOUDFLARE_EXTERNAL_LIMIT;
    return Math.min(SIMLETTRA_LIMIT, providerLimit);
  }
  return Math.min(SIMLETTRA_LIMIT, provider === "resend" ? RESEND_LIMIT : SMTP2GO_LIMIT);
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

async function first<T>(statement: D1PreparedStatement): Promise<T | null> {
  return await statement.first<T>();
}

async function reset(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM provider_events"),
    env.DB.prepare("DELETE FROM recipient_deliveries"),
    env.DB.prepare("DELETE FROM mock_provider_deliveries"),
    env.DB.prepare("DELETE FROM send_operations")
  ]);
}

async function operation(env: Env, operationId: string): Promise<OperationRow | null> {
  return await first<OperationRow>(
    env.DB.prepare("SELECT * FROM send_operations WHERE id = ?").bind(operationId)
  );
}

async function recipients(env: Env, operationId: string): Promise<RecipientRow[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM recipient_deliveries WHERE operation_id = ? ORDER BY recipient"
  ).bind(operationId).all<RecipientRow>();
  return result.results;
}

async function snapshot(env: Env, operationId: string): Promise<unknown> {
  const currentOperation = await operation(env, operationId);
  const currentRecipients = await recipients(env, operationId);
  const mockCount = await first<{ count: number }>(
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM mock_provider_deliveries WHERE operation_id = ?"
    ).bind(operationId)
  );
  const eventCount = await first<{ count: number }>(
    env.DB.prepare("SELECT COUNT(*) AS count FROM provider_events WHERE operation_id = ?").bind(operationId)
  );
  return {
    operation: currentOperation,
    recipients: currentRecipients,
    mockProviderAcceptanceCount: mockCount?.count ?? 0,
    acceptedEventCount: eventCount?.count ?? 0
  };
}

async function establishOperation(
  env: Env,
  operationId: string,
  provider: Provider,
  mimeSize: number,
  limit: number,
  payloadHash: string,
  recipientList: string[]
): Promise<OperationRow> {
  const existing = await operation(env, operationId);
  if (existing) {
    if (existing.provider !== provider || existing.payload_hash !== payloadHash || existing.mime_size !== mimeSize) {
      throw new Response(JSON.stringify({ error: "同一操作编号不能对应不同邮件内容或供应商" }), {
        status: 409,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
    const existingRecipients = await recipients(env, operationId);
    if (existingRecipients.map((item) => item.recipient).join(",") !== [...recipientList].sort().join(",")) {
      throw new Response(JSON.stringify({ error: "同一操作编号不能更换收件人" }), {
        status: 409,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
    return existing;
  }

  const timestamp = now();
  const idempotencyKey = provider === "resend" ? `simlettra:${operationId}` : null;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO send_operations (
         id, provider, state, mime_size, effective_limit, provider_message_id,
         idempotency_key, payload_hash, attempts, last_error, created_at, updated_at
       ) VALUES (?, ?, 'pending', ?, ?, NULL, ?, ?, 0, NULL, ?, ?)`
    ).bind(operationId, provider, mimeSize, limit, idempotencyKey, payloadHash, timestamp, timestamp),
    ...recipientList.map((recipient) =>
      env.DB.prepare(
        `INSERT INTO recipient_deliveries (
           operation_id, recipient, state, provider_event_at, complaint, detail_code, updated_at
         ) VALUES (?, ?, 'pending', NULL, 0, NULL, ?)`
      ).bind(operationId, recipient, timestamp)
    )
  ]);
  const created = await operation(env, operationId);
  if (!created) {
    throw new Error("建立发信操作失败");
  }
  return created;
}

async function updateOperationAndRecipients(
  env: Env,
  operationId: string,
  state: DeliveryState,
  options: { providerMessageId?: string | null; error?: string | null; incrementAttempt?: boolean } = {}
): Promise<void> {
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE send_operations
       SET state = ?,
           provider_message_id = COALESCE(?, provider_message_id),
           attempts = attempts + ?,
           last_error = ?,
           updated_at = ?
       WHERE id = ?`
    ).bind(
      state,
      options.providerMessageId ?? null,
      options.incrementAttempt ? 1 : 0,
      options.error ?? null,
      timestamp,
      operationId
    ),
    env.DB.prepare(
      `UPDATE recipient_deliveries
       SET state = ?, detail_code = ?, updated_at = ?
       WHERE operation_id = ?`
    ).bind(state, options.error ?? null, timestamp, operationId)
  ]);
}

async function acceptByMockProvider(
  env: Env,
  operationRow: OperationRow
): Promise<{ providerMessageId: string; reused: boolean }> {
  if (operationRow.provider === "resend" && operationRow.idempotency_key) {
    const existing = await first<MockDeliveryRow>(
      env.DB.prepare(
        `SELECT provider_message_id, payload_hash
         FROM mock_provider_deliveries
         WHERE provider = 'resend' AND idempotency_key = ?`
      ).bind(operationRow.idempotency_key)
    );
    if (existing) {
      if (existing.payload_hash !== operationRow.payload_hash) {
        throw new Response(JSON.stringify({ error: "Resend 幂等键对应的请求内容发生变化" }), {
          status: 409,
          headers: { "content-type": "application/json; charset=utf-8" }
        });
      }
      return { providerMessageId: existing.provider_message_id, reused: true };
    }
  }

  const providerMessageId = `${operationRow.provider}-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO mock_provider_deliveries (
       provider, provider_message_id, operation_id, payload_hash, idempotency_key, accepted_at
     ) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    operationRow.provider,
    providerMessageId,
    operationRow.id,
    operationRow.payload_hash,
    operationRow.idempotency_key,
    now()
  ).run();
  return { providerMessageId, reused: false };
}

async function send(request: Request, env: Env): Promise<Response> {
  const provider = parseProvider(request.headers.get("x-provider"));
  const operationId = request.headers.get("x-operation-id")?.trim();
  if (!operationId) {
    return json({ error: "缺少 x-operation-id" }, 400);
  }
  const recipientList = parseRecipients(request.headers.get("x-recipients"));
  const recipientMode: CloudflareRecipientMode =
    request.headers.get("x-cloudflare-recipient-mode") === "verified-targets"
      ? "verified-targets"
      : "external";
  const fault = request.headers.get("x-prototype-fault");
  const bytes = new Uint8Array(await request.arrayBuffer());
  const payloadHash = await sha256(bytes);
  const limit = effectiveLimit(provider, recipientMode);

  let current: OperationRow;
  try {
    current = await establishOperation(
      env,
      operationId,
      provider,
      bytes.byteLength,
      limit,
      payloadHash,
      recipientList
    );
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    throw error;
  }

  if (bytes.byteLength > limit) {
    await updateOperationAndRecipients(env, operationId, "failed", {
      error: `邮件总大小 ${bytes.byteLength} 字节超过有效上限 ${limit} 字节`
    });
    return json(
      {
        error: "邮件总大小超过当前域外发信服务的有效上限",
        mimeSize: bytes.byteLength,
        effectiveLimit: limit
      },
      413
    );
  }

  if (current.state === "submitted" || terminalStates.has(current.state)) {
    return json({ repeated: true, snapshot: await snapshot(env, operationId) });
  }

  if (current.state === "unknown" && provider !== "resend") {
    return json(
      {
        error: "供应商可能已经接受邮件，缺少幂等能力，禁止自动重发",
        automaticRetryAllowed: false,
        snapshot: await snapshot(env, operationId)
      },
      409
    );
  }

  await updateOperationAndRecipients(env, operationId, "submitting", { incrementAttempt: true });
  if (fault === "connection-before-accept") {
    await updateOperationAndRecipients(env, operationId, "pending", {
      error: "连接在供应商接受邮件前明确失败"
    });
    return json({ error: "模拟连接失败", acceptedByProvider: false }, 503);
  }

  const refreshed = await operation(env, operationId);
  if (!refreshed) {
    throw new Error("找不到待提交操作");
  }
  const accepted = await acceptByMockProvider(env, refreshed);

  if (fault === "response-lost-after-accept") {
    await updateOperationAndRecipients(env, operationId, "unknown", {
      error: "供应商已经接受邮件，但响应丢失"
    });
    return json(
      {
        error: "模拟供应商接受后响应丢失",
        acceptedByProvider: true,
        providerMessageIdVisibleToSimlettra: false
      },
      504
    );
  }

  await updateOperationAndRecipients(env, operationId, "submitted", {
    providerMessageId: accepted.providerMessageId
  });
  return json(
    {
      accepted: true,
      reusedProviderAcceptance: accepted.reused,
      providerMessageId: accepted.providerMessageId,
      snapshot: await snapshot(env, operationId)
    },
    202
  );
}

function normalizeEvent(provider: Provider, type: string): NormalizedEvent {
  const mappings: Record<Provider, Record<string, NormalizedEvent>> = {
    cloudflare: {
      message_sent: { state: "submitted", complaint: false },
      queued: { state: "submitted", complaint: false },
      delivered: { state: "delivered", complaint: false },
      deferred: { state: "delayed", complaint: false },
      bounced: { state: "bounced", complaint: false },
      failed: { state: "failed", complaint: false },
      rejected: { state: "failed", complaint: false },
      dropped: { state: "failed", complaint: false },
      complained: { state: null, complaint: true }
    },
    resend: {
      "email.sent": { state: "submitted", complaint: false },
      "email.delivered": { state: "delivered", complaint: false },
      "email.delivery_delayed": { state: "delayed", complaint: false },
      "email.bounced": { state: "bounced", complaint: false },
      "email.failed": { state: "failed", complaint: false },
      "email.suppressed": { state: "failed", complaint: false },
      "email.complained": { state: null, complaint: true }
    },
    smtp2go: {
      processed: { state: "submitted", complaint: false },
      delivered: { state: "delivered", complaint: false },
      bounce: { state: "bounced", complaint: false },
      reject: { state: "failed", complaint: false },
      spam: { state: null, complaint: true },
      unsubscribe: { state: null, complaint: false }
    }
  };
  const normalized = mappings[provider][type];
  if (!normalized) {
    throw new Error(`不支持的 ${provider} 事件类型：${type}`);
  }
  return normalized;
}

function shouldTransition(
  current: DeliveryState,
  next: DeliveryState,
  currentOccurredAt: number | null,
  nextOccurredAt: number
): boolean {
  if (terminalStates.has(current)) {
    return false;
  }
  if (currentOccurredAt !== null && nextOccurredAt < currentOccurredAt) {
    return false;
  }
  if (current === "unknown") {
    return true;
  }
  return stateRank[next] >= stateRank[current];
}

async function updateAggregateOperationState(env: Env, operationId: string): Promise<void> {
  const items = await recipients(env, operationId);
  if (items.length === 0) {
    return;
  }
  const states = items.map((item) => item.state);
  let aggregate: DeliveryState;
  if (states.every((state) => state === "delivered")) {
    aggregate = "delivered";
  } else if (states.some((state) => state === "unknown")) {
    aggregate = "unknown";
  } else if (states.some((state) => state === "bounced")) {
    aggregate = "bounced";
  } else if (states.some((state) => state === "failed")) {
    aggregate = "failed";
  } else if (states.some((state) => state === "delayed")) {
    aggregate = "delayed";
  } else if (states.some((state) => state === "submitting")) {
    aggregate = "submitting";
  } else {
    aggregate = states.every((state) => state === "pending") ? "pending" : "submitted";
  }
  await env.DB.prepare(
    "UPDATE send_operations SET state = ?, updated_at = ? WHERE id = ?"
  ).bind(aggregate, now(), operationId).run();
}

async function applyProviderEvent(
  env: Env,
  provider: Provider,
  input: ProviderEventInput,
  rawPayload: string
): Promise<unknown> {
  const currentOperation = await operation(env, input.operationId);
  if (!currentOperation || currentOperation.provider !== provider) {
    throw new Response(JSON.stringify({ error: "事件对应的发信操作不存在或供应商不匹配" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
  const currentRecipient = await first<RecipientRow>(
    env.DB.prepare(
      "SELECT * FROM recipient_deliveries WHERE operation_id = ? AND recipient = ?"
    ).bind(input.operationId, input.recipient.toLowerCase())
  );
  if (!currentRecipient) {
    throw new Response(JSON.stringify({ error: "事件收件人不属于该发信操作" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  const normalized = normalizeEvent(provider, input.type);
  const payloadHash = await sha256(encoder.encode(rawPayload));
  const insertion = await env.DB.prepare(
    `INSERT OR IGNORE INTO provider_events (
       provider, event_id, operation_id, recipient, provider_event_type,
       normalized_state, occurred_at, payload_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    provider,
    input.id,
    input.operationId,
    input.recipient.toLowerCase(),
    input.type,
    normalized.state,
    input.occurredAt,
    payloadHash,
    now()
  ).run();
  if ((insertion.meta.changes ?? 0) === 0) {
    return { duplicate: true, snapshot: await snapshot(env, input.operationId) };
  }

  if (normalized.complaint) {
    await env.DB.prepare(
      `UPDATE recipient_deliveries
       SET complaint = 1, detail_code = ?, updated_at = ?
       WHERE operation_id = ? AND recipient = ?`
    ).bind(input.detailCode ?? input.type, now(), input.operationId, input.recipient.toLowerCase()).run();
  }

  if (
    normalized.state &&
    shouldTransition(
      currentRecipient.state,
      normalized.state,
      currentRecipient.provider_event_at,
      input.occurredAt
    )
  ) {
    await env.DB.prepare(
      `UPDATE recipient_deliveries
       SET state = ?, provider_event_at = ?, detail_code = ?, updated_at = ?
       WHERE operation_id = ? AND recipient = ?`
    ).bind(
      normalized.state,
      input.occurredAt,
      input.detailCode ?? input.type,
      now(),
      input.operationId,
      input.recipient.toLowerCase()
    ).run();
    await updateAggregateOperationState(env, input.operationId);
  }

  return {
    duplicate: false,
    normalized,
    snapshot: await snapshot(env, input.operationId)
  };
}

function decodeResendSecret(secret: string): Uint8Array {
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: string, right: string): boolean {
  const maximum = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximum; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function verifyResendSignature(request: Request, rawBody: string, env: Env): Promise<boolean> {
  const messageId = request.headers.get("svix-id");
  const timestampText = request.headers.get("svix-timestamp");
  const signatures = request.headers.get("svix-signature");
  const timestamp = Number(timestampText);
  if (!messageId || !timestampText || !Number.isFinite(timestamp) || !signatures) {
    return false;
  }
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > RESEND_SIGNATURE_WINDOW_SECONDS) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(decodeResendSecret(env.PROTOTYPE_RESEND_SIGNING_SECRET)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${messageId}.${timestampText}.${rawBody}`))
  );
  const expected = btoa(String.fromCharCode(...signature));
  return signatures
    .split(/\s+/)
    .map((item) => item.startsWith("v1,") ? item.slice(3) : item)
    .some((candidate) => constantTimeEqual(candidate, expected));
}

function verifySmtp2goAuthorization(request: Request, env: Env): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Basic ")) {
    return false;
  }
  const expected = btoa(`${env.PROTOTYPE_SMTP2GO_USERNAME}:${env.PROTOTYPE_SMTP2GO_PASSWORD}`);
  return constantTimeEqual(authorization.slice("Basic ".length), expected);
}

function parseEvent(rawBody: string): ProviderEventInput {
  const parsed = JSON.parse(rawBody) as Partial<ProviderEventInput>;
  if (
    typeof parsed.id !== "string" ||
    typeof parsed.operationId !== "string" ||
    typeof parsed.recipient !== "string" ||
    typeof parsed.type !== "string" ||
    typeof parsed.occurredAt !== "number"
  ) {
    throw new Error("事件缺少必要字段");
  }
  return parsed as ProviderEventInput;
}

async function handleResendEvent(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  if (!(await verifyResendSignature(request, rawBody, env))) {
    return json({ error: "Resend Webhook 签名无效或已过期" }, 401);
  }
  const input = parseEvent(rawBody);
  if (request.headers.get("svix-id") !== input.id) {
    return json({ error: "Svix 消息编号与事件编号不一致" }, 401);
  }
  return json(await applyProviderEvent(env, "resend", input, rawBody));
}

async function handleSmtp2goEvent(request: Request, env: Env): Promise<Response> {
  if (!verifySmtp2goAuthorization(request, env)) {
    return json({ error: "SMTP2GO Webhook 鉴权失败" }, 401);
  }
  const rawBody = await request.text();
  return json(await applyProviderEvent(env, "smtp2go", parseEvent(rawBody), rawBody));
}

async function handleCloudflareSimulation(request: Request, env: Env): Promise<Response> {
  if (!constantTimeEqual(request.headers.get("x-prototype-queue-secret") ?? "", env.PROTOTYPE_QUEUE_SECRET)) {
    return json({ error: "仅本地 Queue 模拟入口可以调用" }, 401);
  }
  const rawBody = await request.text();
  return json(await applyProviderEvent(env, "cloudflare", parseEvent(rawBody), rawBody));
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return json({ ok: true });
  }
  if (url.pathname === "/capabilities") {
    return json({ simlettraLimit: SIMLETTRA_LIMIT, providers: providerCapabilities });
  }
  if (url.pathname === "/events/cloudflare") {
    return json({ error: "Cloudflare 发信事件只从 Queue consumer 接收" }, 404);
  }
  if (request.method !== "POST") {
    return json({ error: "仅接受 POST" }, 405);
  }
  if (url.pathname === "/reset") {
    await reset(env);
    return json({ ok: true });
  }
  if (url.pathname === "/send") {
    return await send(request, env);
  }
  if (url.pathname === "/snapshot") {
    const operationId = url.searchParams.get("operation");
    return operationId ? json(await snapshot(env, operationId)) : json({ error: "缺少 operation" }, 400);
  }
  if (url.pathname === "/events/resend") {
    return await handleResendEvent(request, env);
  }
  if (url.pathname === "/events/smtp2go") {
    return await handleSmtp2goEvent(request, env);
  }
  if (url.pathname === "/simulate/cloudflare-queue") {
    return await handleCloudflareSimulation(request, env);
  }
  return json({ error: "未找到原型接口" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof Response) {
        return error;
      }
      return json(
        {
          error: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : "UnknownError"
        },
        500
      );
    }
  },

  async queue(batch: MessageBatch<ProviderEventInput>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const rawBody = JSON.stringify(message.body);
        await applyProviderEvent(env, "cloudflare", message.body, rawBody);
        message.ack();
      } catch {
        message.retry();
      }
    }
  }
} satisfies ExportedHandler<Env, ProviderEventInput>;
