import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dataDirectory = resolve(root, ".data");
const resultPath = resolve(root, "验证结果.json");
const wranglerCli = resolve(root, "node_modules", "wrangler", "bin", "wrangler.js");
const port = 8820;
const baseUrl = `http://127.0.0.1:${port}`;
const testSecrets = {
  resend: "whsec_" + Buffer.from("simlettra-resend-test-secret").toString("base64"),
  smtp2goUsername: "simlettra-test",
  smtp2goPassword: "smtp2go-test-password",
  queue: "cloudflare-queue-local-test"
};

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
    signal: AbortSignal.timeout(60000)
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function waitForServer(process_) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60000) {
    if (process_.exitCode !== null) {
      throw new Error(`Wrangler 提前退出，退出码 ${process_.exitCode}`);
    }
    try {
      const response = await request("/health");
      if (response.status === 200) {
        return;
      }
    } catch {
      // 等待本地 Worker 完成启动。
    }
    await new Promise((resolve_) => setTimeout(resolve_, 250));
  }
  throw new Error("等待 Wrangler 启动超时");
}

function makeMime(size, operationId) {
  const header = Buffer.from(
    [
      `Message-ID: <${operationId}@example.test>`,
      "From: sender@example.test",
      "To: recipient@example.net",
      `Subject: 域外发信验证 ${operationId}`,
      "MIME-Version: 1.0",
      "Content-Type: application/octet-stream",
      "",
      ""
    ].join("\r\n"),
    "utf8"
  );
  assert.ok(size >= header.byteLength);
  const mime = Buffer.alloc(size, operationId.length % 251);
  header.copy(mime, 0);
  return mime;
}

async function sendMime({
  operationId,
  provider,
  size = 4096,
  recipient = "recipient@example.net",
  recipientMode,
  fault,
  body
}) {
  const headers = {
    "content-type": "message/rfc822",
    "x-operation-id": operationId,
    "x-provider": provider,
    "x-recipients": recipient
  };
  if (recipientMode) {
    headers["x-cloudflare-recipient-mode"] = recipientMode;
  }
  if (fault) {
    headers["x-prototype-fault"] = fault;
  }
  return await request("/send", {
    method: "POST",
    headers,
    body: body ?? makeMime(size, operationId)
  });
}

async function snapshot(operationId) {
  const result = await request(`/snapshot?operation=${encodeURIComponent(operationId)}`, { method: "POST" });
  assert.equal(result.status, 200);
  return result.body;
}

function resendSignature(eventId, timestamp, rawBody) {
  const key = Buffer.from(testSecrets.resend.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key)
    .update(`${eventId}.${timestamp}.${rawBody}`)
    .digest("base64");
  return `v1,${signature}`;
}

async function postEvent(provider, event, options = {}) {
  const rawBody = JSON.stringify(event);
  if (provider === "resend") {
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    return await request("/events/resend", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": event.id,
        "svix-timestamp": String(timestamp),
        "svix-signature": options.invalidSignature
          ? "v1,invalid"
          : resendSignature(event.id, timestamp, rawBody)
      },
      body: rawBody
    });
  }
  if (provider === "smtp2go") {
    const credentials = options.invalidAuthorization
      ? "invalid:credentials"
      : `${testSecrets.smtp2goUsername}:${testSecrets.smtp2goPassword}`;
    return await request("/events/smtp2go", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(credentials).toString("base64")}`
      },
      body: rawBody
    });
  }
  return await request("/simulate/cloudflare-queue", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-prototype-queue-secret": options.invalidAuthorization ? "invalid" : testSecrets.queue
    },
    body: rawBody
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

async function validateLimits() {
  const capabilityResponse = await request("/capabilities");
  assert.equal(capabilityResponse.status, 200);
  assert.equal(capabilityResponse.body.simlettraLimit, 20_000_000);
  assert.equal(capabilityResponse.body.providers.cloudflare.providerLimits.external, 5_242_880);
  assert.equal(capabilityResponse.body.providers.cloudflare.providerLimits.verifiedTargets, 26_214_400);
  assert.equal(capabilityResponse.body.providers.resend.providerLimits.allRecipients, 40_000_000);
  assert.equal(capabilityResponse.body.providers.smtp2go.providerLimits.api, 50_000_000);

  const cases = [
    { id: "cloudflare-external", name: "Cloudflare 普通外部地址", provider: "cloudflare", limit: 5_242_880 },
    {
      id: "cloudflare-verified-targets",
      name: "Cloudflare 全部为已验证目标",
      provider: "cloudflare",
      recipientMode: "verified-targets",
      limit: 20_000_000
    },
    { id: "resend", name: "Resend", provider: "resend", limit: 20_000_000 },
    { id: "smtp2go", name: "SMTP2GO", provider: "smtp2go", limit: 20_000_000 }
  ];
  const evidence = [];
  for (const item of cases) {
    const atLimit = await sendMime({
      operationId: `limit-${item.id}`,
      provider: item.provider,
      recipientMode: item.recipientMode,
      size: item.limit
    });
    assert.equal(atLimit.status, 202, `${item.name} 在上限处应允许提交`);
    assert.equal(atLimit.body.snapshot.operation.mime_size, item.limit);
    assert.equal(atLimit.body.snapshot.operation.effective_limit, item.limit);

    const overLimit = await sendMime({
      operationId: `over-${item.id}`,
      provider: item.provider,
      recipientMode: item.recipientMode,
      size: item.limit + 1
    });
    assert.equal(overLimit.status, 413, `${item.name} 超过一字节应在本地拒绝`);
    assert.equal(overLimit.body.effectiveLimit, item.limit);
    assert.equal((await snapshot(`over-${item.id}`)).mockProviderAcceptanceCount, 0);
    evidence.push({
      provider: item.name,
      effectiveLimit: item.limit,
      exactLimitAccepted: true,
      oneByteOverRejectedLocally: true
    });
  }
  return { capabilities: capabilityResponse.body, cases: evidence };
}

async function validateConnectionRetry() {
  const evidence = [];
  for (const provider of ["cloudflare", "resend", "smtp2go"]) {
    const operationId = `connection-retry-${provider}`;
    const failed = await sendMime({ operationId, provider, fault: "connection-before-accept" });
    assert.equal(failed.status, 503);
    assert.equal(failed.body.acceptedByProvider, false);
    assert.equal((await sendMime({ operationId, provider })).status, 202);
    assert.equal((await sendMime({ operationId, provider })).status, 200);
    const current = await snapshot(operationId);
    assert.equal(current.mockProviderAcceptanceCount, 1);
    assert.equal(current.operation.attempts, 2);
    evidence.push({ provider, attempts: current.operation.attempts, providerAcceptances: 1 });
  }
  return evidence;
}

async function validateResendIdempotency() {
  const operationId = "resend-response-lost";
  const first = await sendMime({ operationId, provider: "resend", fault: "response-lost-after-accept" });
  assert.equal(first.status, 504);
  const second = await sendMime({ operationId, provider: "resend" });
  assert.equal(second.status, 202);
  assert.equal(second.body.reusedProviderAcceptance, true);
  assert.equal((await sendMime({ operationId, provider: "resend" })).status, 200);
  const current = await snapshot(operationId);
  assert.equal(current.mockProviderAcceptanceCount, 1);
  assert.equal(current.operation.state, "submitted");
  assert.equal(current.operation.attempts, 2);
  return {
    attempts: current.operation.attempts,
    providerAcceptances: current.mockProviderAcceptanceCount,
    idempotencyKey: current.operation.idempotency_key
  };
}

async function validateUnknownResults() {
  const evidence = [];
  for (const provider of ["cloudflare", "smtp2go"]) {
    const operationId = `${provider}-response-lost`;
    assert.equal((await sendMime({
      operationId,
      provider,
      fault: "response-lost-after-accept"
    })).status, 504);
    for (let index = 0; index < 2; index += 1) {
      const blocked = await sendMime({ operationId, provider });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.automaticRetryAllowed, false);
    }
    const current = await snapshot(operationId);
    assert.equal(current.operation.state, "unknown");
    assert.equal(current.mockProviderAcceptanceCount, 1);
    evidence.push({ provider, state: current.operation.state, providerAcceptances: 1 });
  }
  return evidence;
}

async function validateAuthentication() {
  const resendOperation = "auth-resend";
  const smtpOperation = "auth-smtp2go";
  await sendMime({ operationId: resendOperation, provider: "resend" });
  await sendMime({ operationId: smtpOperation, provider: "smtp2go" });
  const baseEvent = {
    recipient: "recipient@example.net",
    type: "email.delivered",
    occurredAt: Date.now()
  };
  const invalidSignature = await postEvent("resend", {
    ...baseEvent,
    id: "auth-invalid-signature",
    operationId: resendOperation
  }, { invalidSignature: true });
  assert.equal(invalidSignature.status, 401);
  const expired = await postEvent("resend", {
    ...baseEvent,
    id: "auth-expired",
    operationId: resendOperation
  }, { timestamp: Math.floor(Date.now() / 1000) - 601 });
  assert.equal(expired.status, 401);
  const invalidBasic = await postEvent("smtp2go", {
    id: "auth-invalid-basic",
    operationId: smtpOperation,
    recipient: "recipient@example.net",
    type: "delivered",
    occurredAt: Date.now()
  }, { invalidAuthorization: true });
  assert.equal(invalidBasic.status, 401);
  const publicCloudflare = await request("/events/cloudflare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(publicCloudflare.status, 404);
  const forgedQueue = await postEvent("cloudflare", {
    id: "auth-forged-queue",
    operationId: "not-used",
    recipient: "recipient@example.net",
    type: "delivered",
    occurredAt: Date.now()
  }, { invalidAuthorization: true });
  assert.equal(forgedQueue.status, 401);
  assert.equal((await snapshot(resendOperation)).acceptedEventCount, 0);
  assert.equal((await snapshot(smtpOperation)).acceptedEventCount, 0);
  return {
    invalidResendSignatureRejected: true,
    expiredResendTimestampRejected: true,
    invalidSmtp2goBasicAuthRejected: true,
    publicCloudflareEventEndpointAbsent: true,
    forgedQueueSimulationRejected: true
  };
}

const eventMappings = {
  cloudflare: {
    message_sent: "submitted",
    queued: "submitted",
    delivered: "delivered",
    deferred: "delayed",
    bounced: "bounced",
    failed: "failed",
    rejected: "failed",
    dropped: "failed"
  },
  resend: {
    "email.sent": "submitted",
    "email.delivered": "delivered",
    "email.delivery_delayed": "delayed",
    "email.bounced": "bounced",
    "email.failed": "failed",
    "email.suppressed": "failed"
  },
  smtp2go: {
    processed: "submitted",
    delivered: "delivered",
    bounce: "bounced",
    reject: "failed"
  }
};

async function validateEventMappings() {
  const evidence = [];
  for (const [provider, mappings] of Object.entries(eventMappings)) {
    for (const [eventType, expectedState] of Object.entries(mappings)) {
      const operationId = `mapping-${provider}-${eventType.replaceAll(".", "-")}`;
      await sendMime({ operationId, provider });
      const response = await postEvent(provider, {
        id: `event-${operationId}`,
        operationId,
        recipient: "recipient@example.net",
        type: eventType,
        occurredAt: Date.now()
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.snapshot.recipients[0].state, expectedState);
      evidence.push({ provider, eventType, expectedState });
    }
  }
  return evidence;
}

async function validateDuplicateAndOrdering() {
  const evidence = [];
  const configurations = [
    { provider: "cloudflare", delivered: "delivered", earlier: "deferred", complaint: "complained" },
    {
      provider: "resend",
      delivered: "email.delivered",
      earlier: "email.delivery_delayed",
      complaint: "email.complained"
    },
    { provider: "smtp2go", delivered: "delivered", earlier: "processed", complaint: "spam" }
  ];
  for (const configuration of configurations) {
    const operationId = `ordering-${configuration.provider}`;
    await sendMime({ operationId, provider: configuration.provider });
    const occurredAt = Date.now();
    const deliveredEvent = {
      id: `delivered-${configuration.provider}`,
      operationId,
      recipient: "recipient@example.net",
      type: configuration.delivered,
      occurredAt
    };
    const delivered = await postEvent(configuration.provider, deliveredEvent);
    assert.equal(delivered.status, 200);
    assert.equal(delivered.body.snapshot.recipients[0].state, "delivered");
    const duplicate = await postEvent(configuration.provider, deliveredEvent);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);
    const earlier = await postEvent(configuration.provider, {
      id: `earlier-${configuration.provider}`,
      operationId,
      recipient: "recipient@example.net",
      type: configuration.earlier,
      occurredAt: occurredAt - 60_000
    });
    assert.equal(earlier.body.snapshot.recipients[0].state, "delivered");
    const complaint = await postEvent(configuration.provider, {
      id: `complaint-${configuration.provider}`,
      operationId,
      recipient: "recipient@example.net",
      type: configuration.complaint,
      occurredAt: occurredAt + 60_000
    });
    assert.equal(complaint.body.snapshot.recipients[0].state, "delivered");
    assert.equal(complaint.body.snapshot.recipients[0].complaint, 1);
    const current = await snapshot(operationId);
    assert.equal(current.acceptedEventCount, 3);
    evidence.push({
      provider: configuration.provider,
      duplicateIgnored: true,
      terminalStateNotDowngraded: true,
      complaintStoredSeparately: true
    });
  }
  return evidence;
}

async function validateUnknownResolution() {
  const cases = [
    { provider: "cloudflare", eventType: "delivered" },
    { provider: "smtp2go", eventType: "delivered" }
  ];
  const evidence = [];
  for (const item of cases) {
    const operationId = `unknown-resolution-${item.provider}`;
    await sendMime({ operationId, provider: item.provider, fault: "response-lost-after-accept" });
    assert.equal((await snapshot(operationId)).operation.state, "unknown");
    const event = await postEvent(item.provider, {
      id: `resolution-${item.provider}`,
      operationId,
      recipient: "recipient@example.net",
      type: item.eventType,
      occurredAt: Date.now()
    });
    assert.equal(event.status, 200);
    assert.equal(event.body.snapshot.operation.state, "delivered");
    assert.equal(event.body.snapshot.mockProviderAcceptanceCount, 1);
    evidence.push({ provider: item.provider, resolvedTo: "delivered", providerAcceptances: 1 });
  }
  return evidence;
}

async function validateOperationConflict() {
  const operationId = "operation-conflict";
  assert.equal((await sendMime({ operationId, provider: "resend", size: 4096 })).status, 202);
  const changed = await sendMime({
    operationId,
    provider: "resend",
    size: 4097,
    body: makeMime(4097, `${operationId}-changed`)
  });
  assert.equal(changed.status, 409);
  assert.equal((await snapshot(operationId)).mockProviderAcceptanceCount, 1);
  return { changedPayloadRejected: true, providerAcceptances: 1 };
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
    `PROTOTYPE_RESEND_SIGNING_SECRET:${testSecrets.resend}`,
    "--var",
    `PROTOTYPE_SMTP2GO_USERNAME:${testSecrets.smtp2goUsername}`,
    "--var",
    `PROTOTYPE_SMTP2GO_PASSWORD:${testSecrets.smtp2goPassword}`,
    "--var",
    `PROTOTYPE_QUEUE_SECRET:${testSecrets.queue}`,
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
  assert.equal((await request("/reset", { method: "POST" })).status, 200);

  await runScenario("供应商较小上限与最终 MIME 字节边界", validateLimits);
  await runScenario("明确未接受时三家供应商均可安全重试", validateConnectionRetry);
  await runScenario("Resend 接受后响应丢失使用同一幂等键", validateResendIdempotency);
  await runScenario("Cloudflare 与 SMTP2GO 结果未知时禁止自动重发", validateUnknownResults);
  await runScenario("三种事件入口拒绝无效来源", validateAuthentication);
  await runScenario("三家供应商事件映射为统一状态", validateEventMappings);
  await runScenario("重复与乱序事件不造成状态倒退", validateDuplicateAndOrdering);
  await runScenario("结果未知可由后续供应商事件消解", validateUnknownResolution);
  await runScenario("同一操作编号不能更换邮件内容", validateOperationConflict);

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
      effectiveLimitUsesSmallerValue: failures.every((item) => item.name !== "供应商较小上限与最终 MIME 字节边界"),
      resendIdempotencyPassed: failures.every((item) => item.name !== "Resend 接受后响应丢失使用同一幂等键"),
      unknownResultPolicyPassed: failures.every((item) => item.name !== "Cloudflare 与 SMTP2GO 结果未知时禁止自动重发"),
      eventAuthenticationPassed: failures.every((item) => item.name !== "三种事件入口拒绝无效来源"),
      eventDeduplicationAndOrderingPassed: failures.every((item) => item.name !== "重复与乱序事件不造成状态倒退"),
      realProviderNetworkCallsPerformed: false,
      remoteProviderAccountValidationRequired: true
    }
  };
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`验证完成：${resultPath}\n`);
  process.stdout.write(`${JSON.stringify(result.assessment, null, 2)}\n`);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  if (serverOutput) {
    process.stderr.write(`Wrangler 输出：\n${serverOutput}\n`);
  }
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
