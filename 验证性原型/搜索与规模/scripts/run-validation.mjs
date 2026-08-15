import { spawn, spawnSync } from "node:child_process";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tokenMode = process.argv[2] ?? "bigram";
if (tokenMode !== "bigram" && tokenMode !== "unigram-bigram") {
  throw new Error(`不支持的词元模式：${tokenMode}`);
}
const persistenceDirectoryName = `.data-${tokenMode}`;
const dataDirectory = resolve(root, persistenceDirectoryName);
const resultPath = resolve(root, `验证结果-${tokenMode}.json`);
const wranglerCli = resolve(root, "node_modules", "wrangler", "bin", "wrangler.js");
const port = 8799;
const baseUrl = `http://127.0.0.1:${port}`;

function runWrangler(arguments_) {
  const result = spawnSync(process.execPath, [wranglerCli, ...arguments_], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe"
  });
  if (result.status !== 0) {
    throw new Error(`Wrangler 命令失败：\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${path} 失败：${JSON.stringify(body, null, 2)}`);
  }
  return body;
}

async function waitForServer(process_) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60000) {
    if (process_.exitCode !== null) {
      throw new Error(`Wrangler 提前退出，退出码 ${process_.exitCode}`);
    }
    try {
      await request("/health");
      return;
    } catch {
      await new Promise((resolve_) => setTimeout(resolve_, 250));
    }
  }
  throw new Error("等待 Wrangler 启动超时");
}

async function directorySize(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = resolve(path, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(entryPath);
    } else if (entry.isFile()) {
      total += (await stat(entryPath)).size;
    }
  }
  return total;
}

await rm(dataDirectory, { recursive: true, force: true });
await rm(resultPath, { force: true });

runWrangler([
  "d1",
  "execute",
  "simlettra-search-scale-prototype",
  "--local",
  "--persist-to",
  persistenceDirectoryName,
  "--config",
  "wrangler.jsonc",
  "--file",
  "migrations/0001-create-schema.sql"
]);

const server = spawn(
  process.execPath,
  [
    wranglerCli,
    "dev",
    "--local",
    "--persist-to",
    persistenceDirectoryName,
    "--port",
    String(port),
    "--config",
    "wrangler.jsonc",
    "--log-level",
    "warn"
  ],
  {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  }
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
  const prepared = await request(`/prepare?mode=${tokenMode}`, { method: "POST" });
  const seedRuns = [];

  for (let start = 1; start <= 100000; start += 10000) {
    const result = await request(`/seed?start=${start}&count=10000`, { method: "POST" });
    seedRuns.push(result);
    process.stdout.write(`已生成 ${result.end}/100000 封测试邮件\n`);
  }

  const probe = await request(`/probe?mode=${tokenMode}`);
  const benchmark = await request("/benchmark?rounds=20");
  const stats = {
    ...(await request("/stats")),
    localD1PersistenceBytes: await directorySize(resolve(dataDirectory, "v3", "d1")),
    localTotalPersistenceBytes: await directorySize(dataDirectory)
  };
  const maximumP95 = Math.max(
    ...Object.values(benchmark).map((item) => item.p95Milliseconds)
  );
  const capacityStatus =
    stats.localD1PersistenceBytes <= 300 * 1024 * 1024
      ? "理想"
      : stats.localD1PersistenceBytes <= 400 * 1024 * 1024
        ? "需要优化"
        : "未通过";
  const scopedCommonSearch = benchmark["中文正文常见词搜索（范围词元）"];

  const result = {
    generatedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      compatibilityDate: "2026-08-08",
      migrationNote:
        "Wrangler 4.120.0 在本机使用 d1 migrations apply 返回 bad port；同一迁移文件通过 d1 execute --file 完整执行。"
    },
    prepared,
    seedRuns,
    probe,
    stats,
    benchmark,
    assessment: {
      dataReconciliationPassed:
        stats.users === 50 &&
        stats.messages === 100000 &&
        stats.mailboxEntries === 110000 &&
        stats.mailboxStates === 110000 &&
        stats.searchChunks === 200000 &&
        stats.searchRows === 200000,
      chineseTwoCharacterSearchPassed:
        probe.applicationTokens.twoCharacters === 1 &&
        probe.applicationTokens.fourCharacters === 1,
      singleChineseCharacterSupported: probe.applicationTokens.singleCharacter === 1,
      localP95TargetPassed: maximumP95 <= 500,
      maximumP95Milliseconds: maximumP95,
      scopedSearchRowsReadTargetPassed: scopedCommonSearch.maximumRowsRead <= 20000,
      scopedCommonSearchMaximumRowsRead: scopedCommonSearch.maximumRowsRead,
      capacityStatus
    }
  };

  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`验证完成：${resultPath}\n`);
  process.stdout.write(`${JSON.stringify(result.assessment, null, 2)}\n`);
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
