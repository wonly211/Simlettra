import { argon2id as nobleArgon2id } from "@noble/hashes/argon2.js";
import {
  argon2id as wasmArgon2id,
  setWASMModules
} from "argon2-wasm-edge";
// Wrangler 将依赖包中的预编译 Wasm 作为部署模块载入。
// @ts-expect-error 第三方包未声明 Wasm 模块类型。
import argon2WASM from "argon2-wasm-edge/wasm/argon2.wasm";
// @ts-expect-error 第三方包未声明 Wasm 模块类型。
import blake2bWASM from "argon2-wasm-edge/wasm/blake2b.wasm";

interface Env {
  DB: D1Database;
  PROTOTYPE_ORIGIN?: string;
  PROTOTYPE_INIT_KEY?: string;
}

interface Pbkdf2Record {
  version: 1;
  algorithm: "pbkdf2-sha256";
  iterations: number;
  salt: string;
  hash: string;
}

interface UserRow {
  id: string;
  email: string;
  status: "active" | "disabled" | "deletion_pending";
  password_record: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  token_digest: string;
  csrf_digest: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
  revocation_reason: string | null;
  user_agent: string;
  status?: UserRow["status"];
}

interface LoginLimitRow {
  scope_key: string;
  failure_count: number;
  window_started_at: number;
  blocked_until: number;
}

const encoder = new TextEncoder();
const wasmReady = setWASMModules({ argon2WASM, blake2bWASM });
const defaultIterations = 600_000;
const sessionAbsoluteLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const sessionIdleLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const loginWindowMs = 15 * 60 * 1000;
const accountFailureLimit = 5;
const sourceFailureLimit = 20;
const genericLoginError = { error: "邮箱地址或密码不正确" };

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      ...headers
    }
  });
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const cloudflareSubtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(first: ArrayBuffer, second: ArrayBuffer): boolean;
  };
  return cloudflareSubtle.timingSafeEqual(Uint8Array.from(left).buffer, Uint8Array.from(right).buffer);
}

async function sha256(value: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function derivePbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: Uint8Array.from(salt).buffer, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

async function createPasswordRecord(password: string, iterations = defaultIterations): Promise<Pbkdf2Record> {
  const salt = randomBytes(16);
  const hash = await derivePbkdf2(password, salt, iterations);
  return {
    version: 1,
    algorithm: "pbkdf2-sha256",
    iterations,
    salt: toBase64Url(salt),
    hash: toBase64Url(hash)
  };
}

function parsePasswordRecord(serialized: string): Pbkdf2Record | null {
  try {
    const value = JSON.parse(serialized) as Partial<Pbkdf2Record>;
    if (
      value.version !== 1 ||
      value.algorithm !== "pbkdf2-sha256" ||
      !Number.isInteger(value.iterations) ||
      (value.iterations ?? 0) < 1 ||
      typeof value.salt !== "string" ||
      typeof value.hash !== "string"
    ) {
      return null;
    }
    const salt = fromBase64Url(value.salt);
    const hash = fromBase64Url(value.hash);
    if (salt.byteLength < 16 || hash.byteLength !== 32) {
      return null;
    }
    return value as Pbkdf2Record;
  } catch {
    return null;
  }
}

async function verifyPassword(password: string, serialized: string): Promise<boolean> {
  const record = parsePasswordRecord(serialized);
  if (!record) {
    return false;
  }
  const actual = await derivePbkdf2(password, fromBase64Url(record.salt), record.iterations);
  const expected = fromBase64Url(record.hash);
  return timingSafeEqual(actual, expected);
}

async function benchmark(request: Request): Promise<Response> {
  const body = await request.json<{
    algorithm: "pbkdf2" | "argon2-wasm-edge" | "argon2-noble";
    iterations?: number;
    password: string;
    salt: string;
  }>();
  const salt = fromBase64Url(body.salt);
  const startedAt = performance.now();
  let result: Uint8Array;
  if (body.algorithm === "pbkdf2") {
    result = await derivePbkdf2(body.password, salt, body.iterations ?? defaultIterations);
  } else if (body.algorithm === "argon2-wasm-edge") {
    await wasmReady;
    result = await wasmArgon2id({
      password: body.password,
      salt,
      iterations: 2,
      parallelism: 1,
      memorySize: 19 * 1024,
      hashLength: 32,
      outputType: "binary"
    });
  } else if (body.algorithm === "argon2-noble") {
    result = nobleArgon2id(encoder.encode(body.password), salt, {
      t: 2,
      m: 19 * 1024,
      p: 1,
      dkLen: 32,
      maxmem: 64 * 1024 * 1024
    });
  } else {
    return json({ error: "不支持的算法" }, 400);
  }
  return json({
    algorithm: body.algorithm,
    iterations: body.iterations,
    durationMs: performance.now() - startedAt,
    hash: toBase64Url(result)
  });
}

async function resetPrototype(env: Env): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM login_limits"),
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare("DELETE FROM prototype_settings")
  ]);
  const activePassword = await createPasswordRecord("正确的测试长密码-2026");
  const dummyPassword = await createPasswordRecord("不存在账号的固定虚拟密码-2026");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, email, status, password_record, password_changed_at) VALUES (?, ?, 'active', ?, ?)"
    ).bind("user-active", "owner@example.test", JSON.stringify(activePassword), now),
    env.DB.prepare(
      "INSERT INTO prototype_settings (setting_key, setting_value) VALUES ('dummy_password_record', ?)"
    ).bind(JSON.stringify(dummyPassword))
  ]);
  return json({ reset: true });
}

async function passwordScenarios(env: Env): Promise<Response> {
  const first = await createPasswordRecord("同一个足够长的测试密码");
  const second = await createPasswordRecord("同一个足够长的测试密码");
  const correct = await verifyPassword("同一个足够长的测试密码", JSON.stringify(first));
  const wrong = await verifyPassword("错误密码", JSON.stringify(first));
  const damaged = await verifyPassword("同一个足够长的测试密码", "{损坏记录");
  const unsupported = await verifyPassword(
    "同一个足够长的测试密码",
    JSON.stringify({ ...first, version: 99 })
  );
  return json({
    randomSaltProducesDifferentRecords: first.salt !== second.salt && first.hash !== second.hash,
    correctPasswordAccepted: correct,
    wrongPasswordRejected: !wrong,
    damagedRecordRejected: !damaged,
    unsupportedVersionRejected: !unsupported,
    recordContainsVersionAndParameters:
      first.version === 1 && first.algorithm === "pbkdf2-sha256" && first.iterations === defaultIterations
  });
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

async function getLimit(env: Env, scopeKey: string): Promise<LoginLimitRow | null> {
  return await env.DB.prepare(
    "SELECT scope_key, failure_count, window_started_at, blocked_until FROM login_limits WHERE scope_key = ?"
  ).bind(scopeKey).first<LoginLimitRow>();
}

async function isBlocked(env: Env, scopeKeys: string[], now: number): Promise<boolean> {
  for (const scopeKey of scopeKeys) {
    const current = await getLimit(env, scopeKey);
    if (current && current.blocked_until > now) {
      return true;
    }
  }
  return false;
}

async function registerFailure(env: Env, scopeKey: string, limit: number, now: number): Promise<void> {
  const current = await getLimit(env, scopeKey);
  const withinWindow = current && now - current.window_started_at < loginWindowMs;
  const failureCount = withinWindow ? current.failure_count + 1 : 1;
  const windowStartedAt = withinWindow ? current.window_started_at : now;
  const excess = Math.max(0, failureCount - limit + 1);
  const blockedUntil = excess > 0 ? now + Math.min(15 * 60_000, 30_000 * 2 ** (excess - 1)) : 0;
  await env.DB.prepare(
    `INSERT INTO login_limits (scope_key, failure_count, window_started_at, blocked_until)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(scope_key) DO UPDATE SET
       failure_count = excluded.failure_count,
       window_started_at = excluded.window_started_at,
       blocked_until = excluded.blocked_until`
  ).bind(scopeKey, failureCount, windowStartedAt, blockedUntil).run();
}

async function clearFailures(env: Env, scopeKeys: string[]): Promise<void> {
  await env.DB.batch(scopeKeys.map((scopeKey) => env.DB.prepare("DELETE FROM login_limits WHERE scope_key = ?").bind(scopeKey)));
}

function sessionCookie(token: string): string {
  return `__Host-simlettra_session=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ email: string; password: string; source: string; userAgent?: string }>();
  const email = normalizeEmail(body.email);
  const accountScope = `account:${await sha256(email)}`;
  const sourceScope = `source:${await sha256(body.source)}`;
  const scopeKeys = [accountScope, sourceScope];
  const now = Date.now();
  if (await isBlocked(env, scopeKeys, now)) {
    return json({ error: "登录尝试过多，请稍后再试" }, 429, { "retry-after": "30" });
  }

  const user = await env.DB.prepare(
    "SELECT id, email, status, password_record FROM users WHERE email = ?"
  ).bind(email).first<UserRow>();
  const dummy = await env.DB.prepare(
    "SELECT setting_value FROM prototype_settings WHERE setting_key = 'dummy_password_record'"
  ).first<{ setting_value: string }>();
  if (!dummy) {
    return json({ error: "原型尚未初始化" }, 503);
  }
  const passwordAccepted = await verifyPassword(body.password, user?.password_record ?? dummy.setting_value);
  if (!user || !passwordAccepted || user.status !== "active") {
    await Promise.all([
      registerFailure(env, accountScope, accountFailureLimit, now),
      registerFailure(env, sourceScope, sourceFailureLimit, now)
    ]);
    return json(genericLoginError, 401);
  }

  await clearFailures(env, scopeKeys);
  const token = toBase64Url(randomBytes(32));
  const csrfToken = toBase64Url(randomBytes(32));
  const sessionId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO sessions
      (id, user_id, token_digest, csrf_digest, created_at, last_seen_at, expires_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    sessionId,
    user.id,
    await sha256(token),
    await sha256(csrfToken),
    now,
    now,
    now + sessionAbsoluteLifetimeMs,
    body.userAgent ?? "验证浏览器"
  ).run();
  return json(
    { sessionId, token, csrfToken, userId: user.id },
    200,
    { "set-cookie": sessionCookie(token) }
  );
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  for (const item of cookie.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      return item.slice(separator + 1).trim();
    }
  }
  return null;
}

async function sessionFromRequest(request: Request, env: Env, touch = true): Promise<SessionRow | null> {
  const token = cookieValue(request, "__Host-simlettra_session");
  if (!token) return null;
  const tokenDigest = await sha256(token);
  const session = await env.DB.prepare(
    `SELECT sessions.*, users.status
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_digest = ?`
  ).bind(tokenDigest).first<SessionRow>();
  if (!session) return null;
  const now = Date.now();
  if (
    session.revoked_at !== null ||
    session.status !== "active" ||
    session.expires_at <= now ||
    session.last_seen_at + sessionIdleLifetimeMs <= now
  ) {
    return null;
  }
  if (touch) {
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").bind(now, session.id).run();
  }
  return session;
}

async function requireSession(request: Request, env: Env, touch = true): Promise<SessionRow | Response> {
  const session = await sessionFromRequest(request, env, touch);
  return session ?? json({ error: "会话无效或已过期" }, 401);
}

async function requireCsrf(request: Request, env: Env): Promise<SessionRow | Response> {
  const session = await requireSession(request, env);
  if (session instanceof Response) return session;
  const expectedOrigin = env.PROTOTYPE_ORIGIN ?? "https://mail.example.test";
  const supplied = request.headers.get("x-csrf-token") ?? "";
  const suppliedDigest = await sha256(supplied);
  const csrfAccepted = timingSafeEqual(
    encoder.encode(suppliedDigest),
    encoder.encode(session.csrf_digest)
  );
  if (request.headers.get("origin") !== expectedOrigin || !csrfAccepted) {
    return json({ error: "请求来源验证失败" }, 403);
  }
  return session;
}

async function listSessions(request: Request, env: Env): Promise<Response> {
  const current = await requireSession(request, env);
  if (current instanceof Response) return current;
  const result = await env.DB.prepare(
    `SELECT id, created_at, last_seen_at, expires_at, revoked_at, revocation_reason, user_agent
     FROM sessions WHERE user_id = ? ORDER BY created_at DESC`
  ).bind(current.user_id).all();
  return json({ currentSessionId: current.id, sessions: result.results });
}

async function revokeSession(request: Request, env: Env): Promise<Response> {
  const current = await requireCsrf(request, env);
  if (current instanceof Response) return current;
  const body = await request.json<{ sessionId: string }>();
  const now = Date.now();
  const result = await env.DB.prepare(
    "UPDATE sessions SET revoked_at = ?, revocation_reason = 'user_revoked' WHERE id = ? AND user_id = ? AND revoked_at IS NULL"
  ).bind(now, body.sessionId, current.user_id).run();
  return json({ revoked: result.meta.changes === 1 });
}

async function changePassword(request: Request, env: Env): Promise<Response> {
  const current = await requireCsrf(request, env);
  if (current instanceof Response) return current;
  const body = await request.json<{ currentPassword: string; newPassword: string; revokeOtherSessions: boolean }>();
  const user = await env.DB.prepare(
    "SELECT id, email, status, password_record FROM users WHERE id = ?"
  ).bind(current.user_id).first<UserRow>();
  if (!user || !(await verifyPassword(body.currentPassword, user.password_record))) {
    return json({ error: "当前密码不正确" }, 400);
  }
  const nextRecord = await createPasswordRecord(body.newPassword);
  const now = Date.now();
  const statements = [
    env.DB.prepare("UPDATE users SET password_record = ?, password_changed_at = ? WHERE id = ?")
      .bind(JSON.stringify(nextRecord), now, current.user_id)
  ];
  if (body.revokeOtherSessions) {
    statements.push(
      env.DB.prepare(
        "UPDATE sessions SET revoked_at = ?, revocation_reason = 'password_changed' WHERE user_id = ? AND id <> ? AND revoked_at IS NULL"
      ).bind(now, current.user_id, current.id)
    );
  }
  await env.DB.batch(statements);
  return json({ changed: true, otherSessionsRevoked: body.revokeOtherSessions });
}

async function mutate(request: Request, env: Env): Promise<Response> {
  const current = await requireCsrf(request, env);
  if (current instanceof Response) return current;
  return json({ mutationAccepted: true, sessionId: current.id });
}

async function validateSession(request: Request, env: Env): Promise<Response> {
  const current = await requireSession(request, env, false);
  if (current instanceof Response) return current;
  return json({ valid: true, sessionId: current.id, userId: current.user_id });
}

async function prototypeSessionSnapshot(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT id, user_id, token_digest, csrf_digest, created_at, last_seen_at, expires_at, revoked_at, revocation_reason, user_agent FROM sessions ORDER BY created_at"
  ).all();
  return json({ sessions: result.results });
}

async function prototypeSetSessionTime(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ sessionId: string; lastSeenAt?: number; expiresAt?: number }>();
  await env.DB.prepare(
    "UPDATE sessions SET last_seen_at = COALESCE(?, last_seen_at), expires_at = COALESCE(?, expires_at) WHERE id = ?"
  ).bind(body.lastSeenAt ?? null, body.expiresAt ?? null, body.sessionId).run();
  return json({ updated: true });
}

async function prototypeSetUserStatus(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ status: UserRow["status"] }>();
  if (!(["active", "disabled", "deletion_pending"] as string[]).includes(body.status)) {
    return json({ error: "状态无效" }, 400);
  }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET status = ? WHERE id = 'user-active'").bind(body.status),
    env.DB.prepare(
      "UPDATE sessions SET revoked_at = ?, revocation_reason = ? WHERE user_id = 'user-active' AND revoked_at IS NULL"
    ).bind(now, `user_${body.status}`)
  ]);
  return json({ status: body.status, sessionsRevoked: true });
}

async function prototypeAdminReset(request: Request, env: Env): Promise<Response> {
  const suppliedKey = request.headers.get("x-init-key") ?? "";
  const expectedKey = env.PROTOTYPE_INIT_KEY ?? "prototype-init-key-2026";
  const suppliedDigest = encoder.encode(await sha256(suppliedKey));
  const expectedDigest = encoder.encode(await sha256(expectedKey));
  if (!timingSafeEqual(suppliedDigest, expectedDigest)) {
    return json({ error: "恢复鉴权失败" }, 401);
  }
  const body = await request.json<{ newPassword: string }>();
  const nextRecord = await createPasswordRecord(body.newPassword);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET password_record = ?, password_changed_at = ?, status = 'active' WHERE id = 'user-active'"
    ).bind(JSON.stringify(nextRecord), now),
    env.DB.prepare(
      "UPDATE sessions SET revoked_at = ?, revocation_reason = 'administrator_reset' WHERE user_id = 'user-active' AND revoked_at IS NULL"
    ).bind(now)
  ]);
  return json({ reset: true, allSessionsRevoked: true });
}

async function fetchHandler(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return json({ healthy: true });
  if (request.method === "POST" && url.pathname === "/benchmark") return await benchmark(request);
  if (request.method === "POST" && url.pathname === "/reset") return await resetPrototype(env);
  if (request.method === "POST" && url.pathname === "/password-scenarios") return await passwordScenarios(env);
  if (request.method === "POST" && url.pathname === "/login") return await login(request, env);
  if (request.method === "GET" && url.pathname === "/sessions") return await listSessions(request, env);
  if (request.method === "POST" && url.pathname === "/sessions/revoke") return await revokeSession(request, env);
  if (request.method === "POST" && url.pathname === "/password/change") return await changePassword(request, env);
  if (request.method === "POST" && url.pathname === "/mutate") return await mutate(request, env);
  if (request.method === "GET" && url.pathname === "/session/validate") return await validateSession(request, env);
  if (request.method === "GET" && url.pathname === "/prototype/sessions") return await prototypeSessionSnapshot(env);
  if (request.method === "POST" && url.pathname === "/prototype/session-time") {
    return await prototypeSetSessionTime(request, env);
  }
  if (request.method === "POST" && url.pathname === "/prototype/user-status") {
    return await prototypeSetUserStatus(request, env);
  }
  if (request.method === "POST" && url.pathname === "/prototype/admin-reset") {
    return await prototypeAdminReset(request, env);
  }
  return json({ error: "未找到" }, 404);
}

export default {
  fetch: fetchHandler
} satisfies ExportedHandler<Env>;
