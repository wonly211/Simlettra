import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dataDirectory = resolve(root, ".data");
const resultPath = resolve(root, "验证结果.json");
const wranglerCli = resolve(root, "node_modules", "wrangler", "bin", "wrangler.js");
const port = 8810;
const baseUrl = `http://127.0.0.1:${port}`;

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

async function request(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(30000)
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

function pathFor(endpoint, mode, operation, parameters = {}) {
  const search = new URLSearchParams({ mode, operation, ...parameters });
  return `/${endpoint}?${search}`;
}

async function snapshot(mode, operation) {
  const response = await request(pathFor("snapshot", mode, operation));
  assert.equal(response.status, 200);
  return response.body;
}

async function audit(mode, operation) {
  const response = await request(pathFor("audit", mode, operation));
  assert.equal(response.status, 200);
  return response.body;
}

function assertHidden(value) {
  assert.equal(value.mailboxCount, 0, "故障期间不应存在可见邮箱条目");
  assert.notEqual(value.message?.state, "visible", "故障期间邮件不能处于可见状态");
}

function assertVisible(value) {
  assert.equal(value.operation?.state, "completed");
  assert.equal(value.message?.state, "visible");
  assert.equal(value.mailboxCount, 1);
  assert.equal(value.registryCount, 4);
  assert.equal(value.activeRegistryCount, 4);
  assert.equal(value.actualKeys.length, 4);
  assert.equal(new Set(value.actualKeys).size, 4);
}

function assertDeleted(value) {
  assert.equal(value.operation?.state, "deleted");
  assert.equal(value.message, null);
  assert.equal(value.mailboxCount, 0);
  assert.equal(value.registryCount, 0);
  assert.equal(value.actualKeys.length, 0);
}

async function ingestVisible(mode, operation) {
  if (mode === "kv") {
    const first = await request(pathFor("ingest", mode, operation));
    assert.equal(first.status, 200);
    assert.equal(first.body.outcome, "waiting-consistency");
    assertHidden(first.body.snapshot);
    assert.equal(first.body.snapshot.actualKeys.length, 4);

    const repeatedWait = await request(pathFor("repair", mode, operation));
    assert.equal(repeatedWait.status, 200);
    assert.equal(repeatedWait.body.outcome, "waiting-consistency");
    assertHidden(repeatedWait.body.snapshot);

    const visible = await request(pathFor("repair", mode, operation, { kvConsistent: "true" }));
    assert.equal(visible.status, 200);
    assert.equal(visible.body.outcome, "visible");
    assertVisible(visible.body.snapshot);
  } else {
    const visible = await request(pathFor("ingest", mode, operation));
    assert.equal(visible.status, 200);
    assert.equal(visible.body.outcome, "visible");
    assertVisible(visible.body.snapshot);
  }
  return await snapshot(mode, operation);
}

async function repeatIngest(mode, operation, count = 3) {
  for (let index = 0; index < count; index += 1) {
    const response = await request(
      pathFor("repair", mode, operation, mode === "kv" ? { kvConsistent: "true" } : {})
    );
    assert.equal(response.status, 200);
    assertVisible(response.body.snapshot);
  }
}

async function expectFault(mode, operation, fault, endpoint = "ingest") {
  const response = await request(
    pathFor(endpoint, mode, operation, {
      fault,
      ...(mode === "kv" ? { kvConsistent: "true" } : {})
    })
  );
  assert.ok(response.status >= 500, `${fault} 应返回故障状态`);
  assert.equal(response.body.success, false);
  return response;
}

async function recoverIngest(mode, operation) {
  const response = await request(
    pathFor("repair", mode, operation, mode === "kv" ? { kvConsistent: "true" } : {})
  );
  assert.equal(response.status, 200);
  assertVisible(response.body.snapshot);
  await repeatIngest(mode, operation);
  const integrity = await audit(mode, operation);
  assert.equal(integrity.healthy, true);
  return response.body.snapshot;
}

async function runMode(mode, record) {
  const normal = `${mode}-normal`;
  await ingestVisible(mode, normal);
  await repeatIngest(mode, normal);
  record("正常接收与重复执行", { mode, snapshot: await snapshot(mode, normal) });

  const consistency = `${mode}-consistency`;
  if (mode === "kv") {
    const waiting = await request(pathFor("ingest", mode, consistency));
    assert.equal(waiting.body.outcome, "waiting-consistency");
    assertHidden(waiting.body.snapshot);
    assert.equal(waiting.body.snapshot.actualKeys.length, 4);
    const content = await request(pathFor("content", mode, consistency, { role: "text" }));
    assert.equal(content.status, 404);
    const visible = await request(pathFor("repair", mode, consistency, { kvConsistent: "true" }));
    assertVisible(visible.body.snapshot);
    record("KV 跨地区一致性等待", { mode, hiddenBeforeReady: true, visibleAfterVerification: true });
  }

  for (const fault of [
    "after_operation_created",
    "after_raw_write_intent",
    "after_raw_put",
    "after_first_derived_put",
    "visibility_batch_rollback"
  ]) {
    const operation = `${mode}-${fault}`;
    await expectFault(mode, operation, fault);
    const interrupted = await snapshot(mode, operation);
    assertHidden(interrupted);

    if (mode === "kv" && ["after_raw_put", "after_first_derived_put"].includes(fault)) {
      const waiting = await request(pathFor("repair", mode, operation));
      assert.equal(waiting.status, 200);
      assert.equal(waiting.body.outcome, "waiting-consistency");
      assertHidden(waiting.body.snapshot);
    }

    const recovered = await recoverIngest(mode, operation);
    record(`接收故障恢复：${fault}`, {
      mode,
      interruptedActualObjects: interrupted.actualKeys.length,
      recovered
    });
  }

  const committed = `${mode}-after-visibility-commit`;
  await expectFault(mode, committed, "after_visibility_commit");
  const committedSnapshot = await snapshot(mode, committed);
  assertVisible(committedSnapshot);
  await repeatIngest(mode, committed);
  record("可见提交后调用方失败", { mode, committedSnapshot });

  const missing = `${mode}-missing-derived`;
  await ingestVisible(mode, missing);
  let response = await request(pathFor("corrupt", mode, missing, { action: "delete", role: "text" }));
  assert.equal(response.status, 200);
  let integrity = await audit(mode, missing);
  assert.equal(integrity.missing.length, 1);
  response = await request(pathFor("reconcile", mode, missing));
  assert.equal(response.body.outcome, "repairing");
  assertHidden(await snapshot(mode, missing));
  const denied = await request(pathFor("content", mode, missing, { role: "html" }));
  assert.equal(denied.status, 404);
  const repaired = await recoverIngest(mode, missing);
  assert.equal(repaired.objectStates.find((item) => item.role === "text").generation, 2);
  record("缺失衍生对象重建", { mode, before: integrity, after: await audit(mode, missing) });

  const damaged = `${mode}-damaged-derived`;
  await ingestVisible(mode, damaged);
  response = await request(pathFor("corrupt", mode, damaged, { action: "damage", role: "html" }));
  assert.equal(response.status, 200);
  integrity = await audit(mode, damaged);
  assert.equal(integrity.damaged.length, 1);
  response = await request(pathFor("reconcile", mode, damaged));
  assert.equal(response.body.outcome, "repairing");
  const repairedDamage = await recoverIngest(mode, damaged);
  assert.equal(repairedDamage.objectStates.find((item) => item.role === "html").generation, 2);
  record("损坏衍生对象换键重建", { mode, before: integrity, after: await audit(mode, damaged) });

  const rawLoss = `${mode}-raw-loss`;
  await ingestVisible(mode, rawLoss);
  await request(pathFor("corrupt", mode, rawLoss, { action: "delete", role: "raw" }));
  response = await request(pathFor("reconcile", mode, rawLoss));
  assert.equal(response.body.outcome, "damaged");
  const rawLossSnapshot = await snapshot(mode, rawLoss);
  assertHidden(rawLossSnapshot);
  assert.equal(rawLossSnapshot.message.state, "damaged");
  record("原始对象丢失被明确发现", { mode, snapshot: rawLossSnapshot });

  const orphan = `${mode}-orphan`;
  await ingestVisible(mode, orphan);
  await request(pathFor("corrupt", mode, orphan, { action: "orphan", role: "attachment" }));
  integrity = await audit(mode, orphan);
  assert.equal(integrity.orphaned.length, 1);
  await request(pathFor("corrupt", mode, orphan, { action: "cleanup-orphans", role: "attachment" }));
  const afterOrphanCleanup = await audit(mode, orphan);
  assert.equal(afterOrphanCleanup.healthy, true);
  record("孤立对象对账与清理", { mode, before: integrity, after: afterOrphanCleanup });

  for (const fault of [
    "after_delete_tombstone",
    "after_first_object_delete",
    "delete_batch_rollback",
    "after_delete_commit"
  ]) {
    const operation = `${mode}-${fault}`;
    await ingestVisible(mode, operation);
    await expectFault(mode, operation, fault, "delete");
    const interrupted = await snapshot(mode, operation);
    const content = await request(pathFor("content", mode, operation, { role: "text" }));
    assert.equal(content.status, 404, "删除开始后不能继续访问对象");
    if (fault === "after_delete_commit") {
      assertDeleted(interrupted);
    } else {
      assertHidden(interrupted);
    }
    const recoveredDelete = await request(pathFor("delete", mode, operation));
    assert.equal(recoveredDelete.status, 200);
    assertDeleted(recoveredDelete.body.snapshot);
    for (let index = 0; index < 3; index += 1) {
      const repeated = await request(pathFor("delete", mode, operation));
      assert.equal(repeated.status, 200);
      assertDeleted(await snapshot(mode, operation));
    }
    record(`永久删除故障恢复：${fault}`, {
      mode,
      interruptedActualObjects: interrupted.actualKeys.length,
      completed: true
    });
  }
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

const scenarios = [];
const failures = [];
const record = (name, evidence) => {
  scenarios.push({ name, passed: true, evidence });
  process.stdout.write(`已通过 ${evidence.mode ?? "通用"}：${name}\n`);
};

try {
  await waitForServer(server);
  const resetResponse = await request("/reset");
  assert.equal(resetResponse.status, 200);

  for (const mode of ["r2", "kv"]) {
    try {
      await runMode(mode, record);
    } catch (error) {
      failures.push({
        mode,
        error: error instanceof Error ? error.stack ?? error.message : String(error)
      });
    }
  }

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
      r2ContractPassed: failures.every((failure) => failure.mode !== "r2"),
      kvContractPassed: failures.every((failure) => failure.mode !== "kv"),
      noPartialVisibilityPassed: failures.length === 0,
      idempotentRetryPassed: failures.length === 0,
      reconciliationPassed: failures.length === 0,
      permanentDeletePassed: failures.length === 0,
      d1BatchRollbackPassed: failures.length === 0,
      kvGlobalConsistencyProven: false,
      remoteValidationRequired: true
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
