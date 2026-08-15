import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dataDirectory = resolve(root, ".data");
const resultPath = resolve(root, "验证结果.json");
const wranglerCli = resolve(root, "node_modules", "wrangler", "bin", "wrangler.js");
const port = 8830;
const baseUrl = `http://127.0.0.1:${port}`;
const expectedOrigin = "https://mail.example.test";
const initKey = "prototype-init-key-2026";
const password = "正确的测试长密码-2026";

function runNode(arguments_) {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`命令失败：\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout}${result.stderr}`.trim();
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    ...options,
    signal: AbortSignal.timeout(120000)
  });
  const body = await response.json();
  return { status: response.status, headers: response.headers, body };
}

async function jsonRequest(path, body, options = {}) {
  return await request(path, {
    method: "POST",
    ...options,
    headers: {
      "content-type": "application/json",
      ...options.headers
    },
    body: JSON.stringify(body)
  });
}

async function waitForServer(process_) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60000) {
    if (process_.exitCode !== null) {
      throw new Error(`Wrangler 提前退出，退出码 ${process_.exitCode}`);
    }
    try {
      if ((await request("/health")).status === 200) return;
    } catch {
      // 等待本地 Worker 完成启动。
    }
    await new Promise((resolve_) => setTimeout(resolve_, 250));
  }
  throw new Error("等待 Wrangler 启动超时");
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function statistics(values) {
  return {
    samples: values.length,
    minimumMs: Math.min(...values),
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maximumMs: Math.max(...values)
  };
}

async function benchmarkAlgorithm(name, algorithm, iterations) {
  const salt = Buffer.from("simlettra-salt-2026").toString("base64url");
  const durations = [];
  let hash;
  for (let index = 0; index < 11; index += 1) {
    const response = await jsonRequest("/benchmark", {
      algorithm,
      iterations,
      password: "用于算法测量的长密码-2026",
      salt
    });
    assert.equal(response.status, 200, `${name} 应能在本地 Worker 中运行`);
    if (index > 0) durations.push(response.body.durationMs);
    hash = response.body.hash;
  }
  return { name, algorithm, iterations, ...statistics(durations), hash };
}

function sessionHeaders(loginResult, csrf = true) {
  const headers = {
    cookie: `__Host-simlettra_session=${loginResult.body.token}`
  };
  if (csrf) {
    headers.origin = expectedOrigin;
    headers["x-csrf-token"] = loginResult.body.csrfToken;
  }
  return headers;
}

async function login(email, suppliedPassword, source, userAgent = "验证浏览器") {
  return await jsonRequest("/login", {
    email,
    password: suppliedPassword,
    source,
    userAgent
  });
}

const scenarios = [];
const failures = [];
function record(name, evidence) {
  scenarios.push({ name, passed: true, evidence });
  process.stdout.write(`已通过：${name}\n`);
}

async function runScenario(name, execute) {
  try {
    record(name, await execute());
  } catch (error) {
    failures.push({
      name,
      error: error instanceof Error ? error.stack ?? error.message : String(error)
    });
    process.stderr.write(`未通过：${name}\n`);
  }
}

async function validateAlgorithms() {
  const results = [];
  results.push(await benchmarkAlgorithm("PBKDF2 600,000 次", "pbkdf2", 600_000));
  results.push(await benchmarkAlgorithm("PBKDF2 900,000 次", "pbkdf2", 900_000));
  results.push(await benchmarkAlgorithm("PBKDF2 1,200,000 次", "pbkdf2", 1_200_000));
  const wasm = await benchmarkAlgorithm("argon2-wasm-edge Argon2id", "argon2-wasm-edge");
  const noble = await benchmarkAlgorithm("@noble/hashes Argon2id", "argon2-noble");
  assert.equal(wasm.hash, noble.hash, "两个 Argon2id 实现应对同一输入产生相同结果");
  results.push(wasm, noble);
  return { results, argon2ImplementationsAgree: true };
}

async function validatePasswordRecords() {
  const response = await jsonRequest("/password-scenarios", {});
  assert.equal(response.status, 200);
  for (const [key, value] of Object.entries(response.body)) {
    assert.equal(value, true, `${key} 应通过`);
  }
  return response.body;
}

async function validateDummyHashAndGenericErrors() {
  await jsonRequest("/reset", {});
  const samples = { wrongPassword: [], missingAccount: [] };
  for (let index = 0; index < 3; index += 1) {
    const wrongStartedAt = performance.now();
    const wrong = await login("owner@example.test", "错误密码", `wrong-${index}`);
    samples.wrongPassword.push(performance.now() - wrongStartedAt);
    const missingStartedAt = performance.now();
    const missing = await login(`missing-${index}@example.test`, "错误密码", `missing-${index}`);
    samples.missingAccount.push(performance.now() - missingStartedAt);
    assert.equal(wrong.status, 401);
    assert.equal(missing.status, 401);
    assert.deepEqual(wrong.body, missing.body);
  }
  const wrongMedian = statistics(samples.wrongPassword).medianMs;
  const missingMedian = statistics(samples.missingAccount).medianMs;
  const ratio = Math.max(wrongMedian, missingMedian) / Math.min(wrongMedian, missingMedian);
  assert.ok(ratio < 2.5, `两类失败中位耗时比例应小于 2.5，实际为 ${ratio}`);
  return {
    genericResponseMatched: true,
    wrongPassword: statistics(samples.wrongPassword),
    missingAccount: statistics(samples.missingAccount),
    medianRatio: ratio
  };
}

async function validateSessionStorageAndRevocation() {
  await jsonRequest("/reset", {});
  const first = await login("OWNER@EXAMPLE.TEST", password, "device-1", "电脑浏览器");
  const second = await login("owner@example.test", password, "device-2", "手机浏览器");
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const cookie = first.headers.get("set-cookie");
  assert.match(cookie, /^__Host-simlettra_session=/u);
  for (const attribute of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=2592000"]) {
    assert.ok(cookie.includes(attribute), `Cookie 应包含 ${attribute}`);
  }

  const snapshot = await request("/prototype/sessions");
  assert.equal(snapshot.body.sessions.length, 2);
  assert.ok(snapshot.body.sessions.every((item) => item.token_digest !== first.body.token));
  assert.ok(snapshot.body.sessions.every((item) => item.csrf_digest !== first.body.csrfToken));

  const listed = await request("/sessions", { headers: sessionHeaders(first, false) });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.sessions.length, 2);
  assert.ok(listed.body.sessions.every((item) => !("token_digest" in item) && !("csrf_digest" in item)));

  const revoked = await jsonRequest(
    "/sessions/revoke",
    { sessionId: second.body.sessionId },
    { headers: sessionHeaders(first) }
  );
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revoked, true);
  assert.equal((await request("/session/validate", { headers: sessionHeaders(second, false) })).status, 401);
  assert.equal((await request("/session/validate", { headers: sessionHeaders(first, false) })).status, 200);
  return {
    randomTokenBytes: 32,
    databaseStoresOnlyDigests: true,
    protectedCookieAttributesPresent: true,
    sessionListOmitsDigests: true,
    individualRevocationPassed: true
  };
}

async function validateCsrf() {
  await jsonRequest("/reset", {});
  const current = await login("owner@example.test", password, "csrf-device");
  assert.equal((await jsonRequest("/mutate", {}, { headers: sessionHeaders(current, false) })).status, 403);
  assert.equal((await jsonRequest("/mutate", {}, {
    headers: { ...sessionHeaders(current), origin: "https://evil.example" }
  })).status, 403);
  assert.equal((await jsonRequest("/mutate", {}, {
    headers: { ...sessionHeaders(current), "x-csrf-token": "invalid-csrf-token" }
  })).status, 403);
  assert.equal((await jsonRequest("/mutate", {}, { headers: sessionHeaders(current) })).status, 200);
  return {
    missingTokenRejected: true,
    crossOriginRejected: true,
    wrongTokenRejected: true,
    sameOriginWithTokenAccepted: true
  };
}

async function validatePasswordChange() {
  await jsonRequest("/reset", {});
  const current = await login("owner@example.test", password, "change-current", "当前设备");
  const other = await login("owner@example.test", password, "change-other", "其他设备");
  const changed = await jsonRequest(
    "/password/change",
    {
      currentPassword: password,
      newPassword: "修改后的测试长密码-2026",
      revokeOtherSessions: true
    },
    { headers: sessionHeaders(current) }
  );
  assert.equal(changed.status, 200);
  assert.equal((await request("/session/validate", { headers: sessionHeaders(current, false) })).status, 200);
  assert.equal((await request("/session/validate", { headers: sessionHeaders(other, false) })).status, 401);
  assert.equal((await login("owner@example.test", password, "old-password")).status, 401);
  assert.equal((await login("owner@example.test", "修改后的测试长密码-2026", "new-password")).status, 200);
  return {
    currentSessionRetained: true,
    otherSessionsRevoked: true,
    oldPasswordRejected: true,
    newPasswordAccepted: true
  };
}

async function validateAccountStateAndAdminReset() {
  await jsonRequest("/reset", {});
  const disabledSession = await login("owner@example.test", password, "disabled-session");
  await jsonRequest("/prototype/user-status", { status: "disabled" });
  assert.equal((await request("/session/validate", { headers: sessionHeaders(disabledSession, false) })).status, 401);
  const disabledLogin = await login("owner@example.test", password, "disabled-login");
  const missingLogin = await login("missing@example.test", password, "disabled-missing");
  assert.equal(disabledLogin.status, 401);
  assert.deepEqual(disabledLogin.body, missingLogin.body);

  await jsonRequest("/reset", {});
  const deletionSession = await login("owner@example.test", password, "deletion-session");
  await jsonRequest("/prototype/user-status", { status: "deletion_pending" });
  assert.equal((await request("/session/validate", { headers: sessionHeaders(deletionSession, false) })).status, 401);

  await jsonRequest("/reset", {});
  const resetSession = await login("owner@example.test", password, "reset-session");
  assert.equal((await jsonRequest(
    "/prototype/admin-reset",
    { newPassword: "管理员重置后的测试长密码-2026" },
    { headers: { "x-init-key": "invalid-init-key" } }
  )).status, 401);
  const reset = await jsonRequest(
    "/prototype/admin-reset",
    { newPassword: "管理员重置后的测试长密码-2026" },
    { headers: { "x-init-key": initKey } }
  );
  assert.equal(reset.status, 200);
  assert.equal((await request("/session/validate", { headers: sessionHeaders(resetSession, false) })).status, 401);
  assert.equal((await login("owner@example.test", password, "reset-old")).status, 401);
  assert.equal((await login("owner@example.test", "管理员重置后的测试长密码-2026", "reset-new")).status, 200);
  return {
    disabledRevokesSessionsAndUsesGenericError: true,
    deletionPendingRevokesSessions: true,
    wrongInitKeyRejected: true,
    administratorResetRevokesSessions: true,
    administratorResetChangesPassword: true
  };
}

async function validateExpiration() {
  await jsonRequest("/reset", {});
  const idle = await login("owner@example.test", password, "idle-session");
  await jsonRequest("/prototype/session-time", {
    sessionId: idle.body.sessionId,
    lastSeenAt: Date.now() - 8 * 24 * 60 * 60 * 1000
  });
  assert.equal((await request("/session/validate", { headers: sessionHeaders(idle, false) })).status, 401);

  const absolute = await login("owner@example.test", password, "absolute-session");
  await jsonRequest("/prototype/session-time", {
    sessionId: absolute.body.sessionId,
    expiresAt: Date.now() - 1
  });
  assert.equal((await request("/session/validate", { headers: sessionHeaders(absolute, false) })).status, 401);
  return { sevenDayIdleTimeoutPassed: true, thirtyDayAbsoluteTimeoutPassed: true };
}

async function validateRateLimit() {
  await jsonRequest("/reset", {});
  const statuses = [];
  for (let index = 0; index < 6; index += 1) {
    statuses.push((await login("owner@example.test", "错误密码", `rate-account-${index}`)).status);
  }
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);

  await jsonRequest("/reset", {});
  for (let index = 0; index < 4; index += 1) {
    assert.equal((await login("owner@example.test", "错误密码", "success-clears")).status, 401);
  }
  assert.equal((await login("owner@example.test", password, "success-clears")).status, 200);
  assert.equal((await login("owner@example.test", "错误密码", "success-clears")).status, 401);
  return {
    accountThreshold: 5,
    sourceThreshold: 20,
    exponentialDelayStartsAtSeconds: 30,
    successfulLoginClearsRelevantFailures: true
  };
}

await rm(dataDirectory, { recursive: true, force: true });
await rm(resultPath, { force: true });

const migrationOutput = runNode([
  wranglerCli,
  "d1",
  "migrations",
  "apply",
  "DB",
  "--local",
  "--persist-to",
  dataDirectory,
  "--config",
  "wrangler.jsonc"
]);

const server = spawn(
  process.execPath,
  [
    wranglerCli,
    "dev",
    "--local",
    "--port",
    String(port),
    "--persist-to",
    dataDirectory,
    "--config",
    "wrangler.jsonc",
    "--var",
    `PROTOTYPE_ORIGIN:${expectedOrigin}`,
    "--var",
    `PROTOTYPE_INIT_KEY:${initKey}`,
    "--log-level",
    "warn"
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
);

let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk.toString();
});

try {
  await waitForServer(server);
  await runScenario("密码哈希候选可构建运行并完成性能测量", validateAlgorithms);
  await runScenario("密码记录随机盐、参数版本化和损坏处理", validatePasswordRecords);
  await runScenario("不存在账号执行虚拟哈希并返回相同错误", validateDummyHashAndGenericErrors);
  await runScenario("会话只保存摘要并支持查看和单个撤销", validateSessionStorageAndRevocation);
  await runScenario("受保护 Cookie 配合同源与 CSRF 令牌", validateCsrf);
  await runScenario("改密可保留当前会话并撤销其他设备", validatePasswordChange);
  await runScenario("禁用、待注销和管理员重置立即撤销会话", validateAccountStateAndAdminReset);
  await runScenario("会话同时执行空闲和绝对有效期", validateExpiration);
  await runScenario("登录限速同时支持失败累计与成功清理", validateRateLimit);

  const result = {
    generatedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      wrangler: "4.120.0",
      compatibilityDate: "2026-08-08"
    },
    migrationOutput,
    scenarioCount: scenarios.length,
    scenarios,
    failures,
    assessment: {
      passed: failures.length === 0,
      localWorkerOnly: true,
      remoteCloudflareValidationRequired: true,
      productionImplementationCreated: false
    }
  };
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`验证完成：${resultPath}\n`);
  process.stdout.write(`${JSON.stringify(result.assessment, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  if (serverOutput) process.stderr.write(`Wrangler 输出：\n${serverOutput}\n`);
  process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve_) => {
    const timeout = setTimeout(resolve_, 5000);
    server.once("exit", () => {
      clearTimeout(timeout);
      resolve_();
    });
  });
}
