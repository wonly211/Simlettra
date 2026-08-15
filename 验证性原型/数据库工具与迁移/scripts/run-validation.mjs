import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runtimeMigrations = resolve(root, ".运行迁移");
const wranglerState = resolve(root, ".wrangler");
const originalState = resolve(root, ".wrangler-original");
const artifactsDirectory = resolve(root, ".artifacts");
const backupPath = resolve(artifactsDirectory, "权威数据逻辑备份.json");
const unsupportedExportPath = resolve(artifactsDirectory, "不支持的物理导出.sql");
const resultPath = resolve(root, "验证结果.json");
const wranglerCli = resolve(root, "node_modules", "wrangler", "bin", "wrangler.js");
const drizzleKitCli = resolve(root, "node_modules", "drizzle-kit", "bin.cjs");
const drizzleConfig = "wrangler.drizzle.jsonc";
const prismaConfig = "wrangler.prisma.jsonc";

function runNode(arguments_, { expectFailure = false } = {}) {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 20 * 1024 * 1024
  });
  if (!expectFailure && result.status !== 0) {
    throw new Error(`命令失败：\n${result.stdout}\n${result.stderr}`);
  }
  if (expectFailure && result.status === 0) {
    throw new Error(`命令本应失败但成功：\n${result.stdout}\n${result.stderr}`);
  }
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`.trim()
  };
}

function wrangler(arguments_, options) {
  return runNode([wranglerCli, ...arguments_], options);
}

async function copyMigration(name) {
  await cp(resolve(root, "migrations", name), resolve(runtimeMigrations, name));
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    ...options,
    signal: AbortSignal.timeout(60000)
  });
  const body = await response.json();
  return { status: response.status, headers: response.headers, body };
}

async function jsonRequest(baseUrl, path, body, options = {}) {
  return await request(baseUrl, path, {
    method: "POST",
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
    body: JSON.stringify(body)
  });
}

async function startWorker(config, port) {
  const process_ = spawn(
    process.execPath,
    [
      wranglerCli,
      "dev",
      "--local",
      "--port",
      String(port),
      "--config",
      config,
      "--log-level",
      "warn"
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
  );
  let output = "";
  process_.stdout.on("data", (chunk) => { output += chunk.toString(); });
  process_.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60000) {
    if (process_.exitCode !== null) {
      throw new Error(`Wrangler 提前退出，退出码 ${process_.exitCode}\n${output}`);
    }
    try {
      if ((await request(baseUrl, "/health")).status === 200) {
        return { process: process_, baseUrl, output: () => output };
      }
    } catch {
      // 等待本地 Worker 完成启动。
    }
    await new Promise((resolve_) => setTimeout(resolve_, 250));
  }
  process_.kill("SIGTERM");
  throw new Error(`等待 Wrangler 启动超时\n${output}`);
}

async function stopWorker(worker) {
  worker.process.kill("SIGTERM");
  await new Promise((resolve_) => {
    const timeout = setTimeout(resolve_, 5000);
    worker.process.once("exit", () => {
      clearTimeout(timeout);
      resolve_();
    });
  });
}

function parseUpload(output) {
  const match = output.match(/Total Upload:\s+([\d.]+) KiB\s+\/ gzip:\s+([\d.]+) KiB/u);
  if (!match) throw new Error(`无法解析 Worker 包体：\n${output}`);
  return { uploadKiB: Number(match[1]), gzipKiB: Number(match[2]) };
}

function normalizeRows(rows) {
  return rows.map((row) => ({
    entryId: row.entryId,
    messageId: row.messageId,
    subject: row.subject,
    previewText: row.previewText,
    receivedAt: Number(row.receivedAt),
    isRead: Boolean(row.isRead),
    hasAttachments: Boolean(row.hasAttachments),
    deliveredAddress: row.deliveredAddress
  }));
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
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    failures.push({ name, error: detail });
    process.stderr.write(`未通过：${name}\n${detail}\n`);
  }
}

await rm(runtimeMigrations, { recursive: true, force: true });
await rm(wranglerState, { recursive: true, force: true });
await rm(originalState, { recursive: true, force: true });
await rm(artifactsDirectory, { recursive: true, force: true });
await rm(resultPath, { force: true });
await mkdir(runtimeMigrations, { recursive: true });
await mkdir(artifactsDirectory, { recursive: true });

await copyMigration("0000_建立基础验证表.sql");
const firstMigration = wrangler(["d1", "migrations", "apply", "DB", "--local", "--config", drizzleConfig]);
wrangler([
  "d1",
  "execute",
  "DB",
  "--local",
  "--file",
  "fixtures/升级前数据.sql",
  "--config",
  drizzleConfig
]);
await copyMigration("0001_增加邮件摘要.sql");
await copyMigration("0002_建立搜索索引.sql");
const upgradeMigration = wrangler(["d1", "migrations", "apply", "DB", "--local", "--config", drizzleConfig]);
const repeatedMigration = wrangler(["d1", "migrations", "apply", "DB", "--local", "--config", drizzleConfig]);

const noSchemaChange = runNode([
  drizzleKitCli,
  "generate",
  "--config",
  "drizzle.config.ts",
  "--name",
  "重复生成检查"
]);

const drizzleBuild = parseUpload(
  wrangler(["deploy", "--dry-run", "--config", drizzleConfig]).output
);
const prismaBuild = parseUpload(
  wrangler(["deploy", "--dry-run", "--config", prismaConfig]).output
);

let drizzleWorker;
let prismaWorker;
let countsBeforeBackup;
let drizzleDefaultIds;

try {
  drizzleWorker = await startWorker(drizzleConfig, 8840);

  await runScenario("生成迁移、手写 FTS5 与 Wrangler 迁移账本共存", async () => {
    const schema = await request(drizzleWorker.baseUrl, "/schema-check");
    assert.equal(schema.status, 200);
    assert.equal(schema.body.foreignKeyViolations.length, 0);
    assert.equal(schema.body.upgradePreviewText, "");
    assert.deepEqual(
      schema.body.migrations.map((item) => item.name),
      ["0000_建立基础验证表.sql", "0001_增加邮件摘要.sql", "0002_建立搜索索引.sql"]
    );
    assert.equal(schema.body.objects.length, 6);
    assert.equal(noSchemaChange.output.includes("No schema changes"), true);
    return {
      firstMigrationApplied: firstMigration.output.includes("0000_建立基础验证表.sql"),
      upgradeMigrationsApplied: upgradeMigration.output.includes("0002_建立搜索索引.sql"),
      repeatedApplyDidNotRepeat: repeatedMigration.output.includes("No migrations to apply"),
      generatedSchemaHasNoDrift: true,
      foreignKeyViolations: 0,
      preexistingRowReceivedDefault: true
    };
  });

  const seed = await jsonRequest(drizzleWorker.baseUrl, "/seed", {});
  assert.equal(seed.status, 200);
  countsBeforeBackup = (await request(drizzleWorker.baseUrl, "/counts")).body;

  await runScenario("Drizzle 与原生 D1 组合列表返回一致结果", async () => {
    const query = "?user=user-owner&address=address-owner&unread=1&limit=10";
    const drizzleResult = await request(drizzleWorker.baseUrl, `/list/drizzle${query}`);
    const rawResult = await request(drizzleWorker.baseUrl, `/list/raw${query}`);
    assert.equal(drizzleResult.status, 200);
    assert.equal(rawResult.status, 200);
    assert.deepEqual(normalizeRows(drizzleResult.body.rows), normalizeRows(rawResult.body.rows));
    assert.ok(drizzleResult.body.rows.length > 0);
    return {
      resultCount: drizzleResult.body.rows.length,
      sameRows: true,
      rawRowsRead: rawResult.body.meta.rows_read
    };
  });

  await runScenario("查询始终按当前用户限制并使用键集分页", async () => {
    const owner = await request(drizzleWorker.baseUrl, "/list/drizzle?user=user-owner&limit=10");
    const other = await request(drizzleWorker.baseUrl, "/list/drizzle?user=user-other&limit=20");
    assert.equal(owner.body.rows.length, 10);
    assert.equal(other.body.rows.length, 1);
    assert.equal(other.body.rows[0].entryId, "other-entry");
    const last = owner.body.rows.at(-1);
    const next = await request(
      drizzleWorker.baseUrl,
      `/list/drizzle?user=user-owner&limit=10&beforeReceivedAt=${last.receivedAt}&beforeId=${last.messageId}`
    );
    const firstIds = owner.body.rows.map((item) => item.entryId);
    const nextIds = next.body.rows.map((item) => item.entryId);
    assert.equal(nextIds.some((id) => firstIds.includes(id)), false);
    drizzleDefaultIds = firstIds;
    return { ownerFirstPage: firstIds, ownerSecondPage: nextIds, otherUserRows: 1, overlap: 0 };
  });

  await runScenario("FTS5 参数化搜索限制邮箱范围并抵抗结构注入", async () => {
    const owner = await request(drizzleWorker.baseUrl, "/search?scope=user-owner&term=预算");
    const other = await request(drizzleWorker.baseUrl, "/search?scope=user-other&term=预算");
    const malicious = await request(
      drizzleWorker.baseUrl,
      `/search?scope=user-owner&term=${encodeURIComponent('预算" OR *')}`
    );
    assert.deepEqual(owner.body.messageIds, ["message-000", "message-003", "message-006", "message-009"]);
    assert.deepEqual(other.body.messageIds, []);
    assert.equal(malicious.status, 200);
    assert.ok(malicious.body.messageIds.length <= owner.body.messageIds.length);
    return {
      ownerMatches: owner.body.messageIds,
      otherScopeMatches: 0,
      maliciousInputChangedSqlStructure: false
    };
  });

  await runScenario("Drizzle batch 任一语句失败时不留下半条数据", async () => {
    const result = await jsonRequest(drizzleWorker.baseUrl, "/batch-failure", {});
    assert.equal(result.body.rejected, true);
    assert.equal(result.body.messageCount, 0);
    assert.equal(result.body.entryCount, 0);
    return result.body;
  });

  await runScenario("超过 D1 绑定参数上限的操作按 90 项分块", async () => {
    const result = await jsonRequest(drizzleWorker.baseUrl, "/chunk-update", { ids: seed.body.ownerEntryIds });
    assert.deepEqual(result.body.chunkSizes, [90, 90, 25]);
    assert.equal(result.body.changes, 205);
    return result.body;
  });

  await stopWorker(drizzleWorker);
  drizzleWorker = undefined;

  prismaWorker = await startWorker(prismaConfig, 8841);
  await runScenario("Prisma D1 适配器能够读取同一数据库", async () => {
    const owner = await request(prismaWorker.baseUrl, "/list?user=user-owner");
    const other = await request(prismaWorker.baseUrl, "/list?user=user-other");
    assert.equal(owner.status, 200);
    assert.equal(other.status, 200);
    assert.equal(owner.body.rows.length, 20);
    assert.equal(other.body.rows.length, 1);
    assert.equal(other.body.rows[0].id, "other-entry");
    assert.deepEqual(
      owner.body.rows.slice(0, 10).map((item) => item.id),
      drizzleDefaultIds
    );
    return { ownerRows: 20, otherRows: 1, sameFirstPageIds: true };
  });
  await stopWorker(prismaWorker);
  prismaWorker = undefined;

  await runScenario("Drizzle 与 Prisma Worker 干运行打包均成功", async () => {
    assert.ok(drizzleBuild.gzipKiB < prismaBuild.gzipKiB);
    return {
      drizzle: drizzleBuild,
      prisma: prismaBuild,
      prismaToDrizzleGzipRatio: prismaBuild.gzipKiB / drizzleBuild.gzipKiB
    };
  });

  await cp(
    resolve(root, "fixtures", "故意失败的迁移.sql"),
    resolve(runtimeMigrations, "0003_故意失败的迁移.sql")
  );
  const failedMigration = wrangler(
    ["d1", "migrations", "apply", "DB", "--local", "--config", drizzleConfig],
    { expectFailure: true }
  );
  await rm(resolve(runtimeMigrations, "0003_故意失败的迁移.sql"), { force: true });
  drizzleWorker = await startWorker(drizzleConfig, 8840);
  await runScenario("失败迁移整体回滚且不写入迁移账本", async () => {
    const schema = await request(drizzleWorker.baseUrl, "/schema-check");
    assert.equal(schema.body.failedMigrationMarkerExists, false);
    assert.equal(schema.body.migrations.some((item) => item.name.includes("故意失败")), false);
    return {
      commandFailedAsExpected: failedMigration.status !== 0,
      partialMarkerExists: false,
      migrationLedgerRecordedFailure: false
    };
  });
  await stopWorker(drizzleWorker);
  drizzleWorker = undefined;

  drizzleWorker = await startWorker(drizzleConfig, 8840);
  const logicalBackupResult = await request(drizzleWorker.baseUrl, "/backup-logical");
  assert.equal(logicalBackupResult.status, 200);
  await writeFile(backupPath, `${JSON.stringify(logicalBackupResult.body, null, 2)}\n`, "utf8");
  await stopWorker(drizzleWorker);
  drizzleWorker = undefined;

  const unsupportedPhysicalExport = wrangler([
    "d1",
    "export",
    "DB",
    "--local",
    "--output",
    unsupportedExportPath,
    "--skip-confirmation",
    "--config",
    drizzleConfig
  ], { expectFailure: true });
  await runScenario("D1 物理导出明确拒绝包含 FTS5 的数据库", async () => {
    assert.equal(unsupportedPhysicalExport.output.includes("cannot export databases with Virtual Tables"), true);
    return {
      exportRejected: true,
      reason: "D1 不支持导出包含虚拟表的数据库",
      workaroundUsesLogicalAuthoritativeBackup: true
    };
  });

  await rename(wranglerState, originalState);
  try {
    wrangler([
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--config",
      drizzleConfig
    ]);
    drizzleWorker = await startWorker(drizzleConfig, 8840);
    await runScenario("权威普通表逻辑备份可以恢复并重建派生搜索索引", async () => {
      const restoredResponse = await jsonRequest(
        drizzleWorker.baseUrl,
        "/restore-logical",
        logicalBackupResult.body
      );
      assert.equal(restoredResponse.status, 200);
      const rebuild = await jsonRequest(drizzleWorker.baseUrl, "/rebuild-search", {});
      assert.equal(rebuild.status, 200);
      const restored = await request(drizzleWorker.baseUrl, "/counts");
      assert.deepEqual(
        {
          users: restored.body.users,
          messages: restored.body.messages,
          entries: restored.body.entries
        },
        {
          users: countsBeforeBackup.users,
          messages: countsBeforeBackup.messages,
          entries: countsBeforeBackup.entries
        }
      );
      assert.ok(restored.body.searchChunks > 0);
      const searchAfterRestore = await request(drizzleWorker.baseUrl, "/search?scope=user-owner&term=预算");
      assert.ok(searchAfterRestore.body.messageIds.length > 0);
      return {
        backupFile: "权威数据逻辑备份.json",
        excludedDerivedTables: logicalBackupResult.body.excludedDerivedData,
        before: countsBeforeBackup,
        restored: restored.body,
        rebuiltSearchChunks: rebuild.body.rebuilt,
        searchWorksAfterRebuild: true
      };
    });
    await stopWorker(drizzleWorker);
    drizzleWorker = undefined;
  } finally {
    await rm(wranglerState, { recursive: true, force: true });
    await rename(originalState, wranglerState);
  }

  const result = {
    generatedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      wrangler: "4.120.0",
      drizzleOrm: "0.45.2",
      drizzleKit: "0.31.10",
      prisma: "7.9.1",
      compatibilityDate: "2026-08-08"
    },
    scenarioCount: scenarios.length,
    scenarios,
    failures,
    assessment: {
      passed: failures.length === 0,
      recommendedRuntimeCandidate: "drizzle",
      recommendedMigrationExecutor: "wrangler-d1-migrations",
      prismaD1AdapterPreview: true,
      localWorkerOnly: true,
      remoteTimeTravelValidationRequired: true,
      productionSchemaCreated: false
    }
  };
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`验证完成：${resultPath}\n`);
  process.stdout.write(`${JSON.stringify(result.assessment, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  if (drizzleWorker) process.stderr.write(`Drizzle Wrangler 输出：\n${drizzleWorker.output()}\n`);
  if (prismaWorker) process.stderr.write(`Prisma Wrangler 输出：\n${prismaWorker.output()}\n`);
  process.exitCode = 1;
} finally {
  if (drizzleWorker) await stopWorker(drizzleWorker);
  if (prismaWorker) await stopWorker(prismaWorker);
  if (await import("node:fs").then(({ existsSync }) => existsSync(originalState))) {
    await rm(wranglerState, { recursive: true, force: true });
    await rename(originalState, wranglerState);
  }
}
