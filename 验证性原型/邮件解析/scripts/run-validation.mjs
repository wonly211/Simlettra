import { spawn, spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const generatedDirectory = resolve(root, ".generated");
const resultPath = resolve(root, "验证结果.json");
const wranglerCli = resolve(root, "node_modules", "wrangler", "bin", "wrangler.js");
const generator = resolve(root, "scripts", "generate-samples.mjs");
const nodeParser = resolve(root, "scripts", "parse-in-node.mjs");
const port = 8800;
const baseUrl = `http://127.0.0.1:${port}`;

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index] ?? 0;
}

function runNode(arguments_) {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`Node 子进程失败：\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, {
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
      // 继续等待本地 Worker。
    }
    await new Promise((resolve_) => setTimeout(resolve_, 250));
  }
  throw new Error("等待 Wrangler 启动超时");
}

function attachmentMap(attachments) {
  return new Map(attachments.map((attachment) => [attachment.filename, attachment]));
}

function normalizeContentId(value) {
  return typeof value === "string" ? value.replace(/^<|>$/g, "") : value;
}

function verifyExpected(sample, body) {
  const failures = [];
  const expected = sample.expected;
  if (!body.success) {
    if (expected.mustReject && expected.errorIncludes && !body.errorMessage?.includes(expected.errorIncludes)) {
      failures.push(`拒绝原因不匹配：${body.errorName}: ${body.errorMessage}`);
    } else if (!expected.mustReject && !expected.controlledOutcome) {
      failures.push(`解析失败：${body.errorName}: ${body.errorMessage}`);
    }
    return failures;
  }

  if (expected.mustReject) {
    failures.push("应当拒绝的邮件被解析器接受");
    return failures;
  }

  if (expected.subject && body.summary.subject !== expected.subject) {
    failures.push(`主题不匹配：${body.summary.subject}`);
  }
  if (expected.messageId && body.summary.messageId !== expected.messageId) {
    failures.push(`Message-ID 不匹配：${body.summary.messageId}`);
  }
  if (expected.textIncludes && !`${body.summary.textStart}${body.summary.textEnd}`.includes(expected.textIncludes)) {
    failures.push("纯文本正文未找到预期标记");
  }
  if (expected.textEndsWith && !body.summary.textEnd.includes(expected.textEndsWith)) {
    failures.push("纯文本正文结尾标记不匹配");
  }
  if (expected.minimumTextCharacters && body.summary.textCharacters < expected.minimumTextCharacters) {
    failures.push(`纯文本长度不足：${body.summary.textCharacters}`);
  }
  if (expected.htmlIncludes && !body.summary.htmlStart.includes(expected.htmlIncludes)) {
    failures.push("HTML 正文未找到预期标记");
  }
  if (expected.attachmentCount !== undefined && body.summary.attachmentCount !== expected.attachmentCount) {
    failures.push(`附件数量不匹配：${body.summary.attachmentCount}`);
  }
  if (
    expected.totalAttachmentBytes !== undefined &&
    body.summary.totalAttachmentBytes !== expected.totalAttachmentBytes
  ) {
    failures.push(`附件总字节数不匹配：${body.summary.totalAttachmentBytes}`);
  }
  if (expected.attachments) {
    const actual = attachmentMap(body.summary.attachments);
    if (actual.size !== expected.attachments.length) {
      failures.push(`附件数量不匹配：${actual.size}`);
    }
    for (const expectedAttachment of expected.attachments) {
      const item = actual.get(expectedAttachment.filename);
      if (!item) {
        failures.push(`缺少附件：${expectedAttachment.filename}`);
        continue;
      }
      if (item.size !== expectedAttachment.size) {
        failures.push(`${expectedAttachment.filename} 大小不匹配：${item.size}`);
      }
      if (item.sha256 !== expectedAttachment.sha256) {
        failures.push(`${expectedAttachment.filename} 哈希不匹配`);
      }
      if (
        expectedAttachment.contentId &&
        normalizeContentId(item.contentId) !== normalizeContentId(expectedAttachment.contentId)
      ) {
        failures.push(`${expectedAttachment.filename} Content-ID 不匹配：${item.contentId}`);
      }
    }
  }
  if (
    expected.rfc822DepthExceeded &&
    !body.summary.attachments.some((attachment) => attachment.rfc822DepthExceeded)
  ) {
    failures.push("超过 RFC822 深度限制的子邮件未被标记为附件");
  }
  return failures;
}

function fingerprint(body) {
  if (!body.success) {
    return JSON.stringify({ success: false, errorName: body.errorName, errorMessage: body.errorMessage });
  }
  return JSON.stringify(body.summary);
}

await rm(resultPath, { force: true });
runNode([generator]);
const manifest = JSON.parse(await readFile(resolve(generatedDirectory, "样本清单.json"), "utf8"));

const server = spawn(
  process.execPath,
  [
    wranglerCli,
    "dev",
    "--local",
    "--port",
    String(port),
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

try {
  await waitForServer(server);
  const sampleResults = [];
  let healthChecksPassed = true;

  for (const sample of manifest.samples) {
    const path = resolve(generatedDirectory, sample.filename);
    const raw = await readFile(path);
    const modes = sample.id === "large-single-attachment" ? ["arraybuffer", "stream"] : ["arraybuffer"];
    const modeResults = [];

    for (const mode of modes) {
      const rounds = [];
      for (let round = 0; round < sample.rounds; round += 1) {
        const response = await request(`/parse?mode=${mode}`, {
          method: "POST",
          headers: {
            "content-type": "message/rfc822",
            "content-length": String(raw.byteLength),
            "x-simlettra-sample": sample.id
          },
          body: raw
        });
        const failures = verifyExpected(sample, response.body);
        rounds.push({ status: response.status, body: response.body, failures });
      }

      const healthy = await request("/health");
      healthChecksPassed &&= healthy.status === 200 && healthy.body.ok === true;
      const parseTimes = rounds.filter((round) => round.body.success).map((round) => round.body.parseMilliseconds);
      const totalTimes = rounds.filter((round) => round.body.success).map((round) => round.body.totalMilliseconds);
      const fingerprints = new Set(rounds.map((round) => fingerprint(round.body)));
      modeResults.push({
        mode,
        rounds: rounds.length,
        successfulRounds: rounds.filter((round) => round.body.success).length,
        correctnessPassed: rounds.every((round) => round.failures.length === 0),
        deterministic: fingerprints.size === 1,
        parseP95Milliseconds: percentile(parseTimes, 0.95),
        parseMaximumMilliseconds: Math.max(0, ...parseTimes),
        totalP95Milliseconds: percentile(totalTimes, 0.95),
        failures: rounds.flatMap((round) => round.failures),
        firstResult: rounds[0]?.body
      });
    }

    const nodeModes = sample.expected.mustReject || sample.id === "malformed"
      ? []
      : sample.rawBytes >= 19_000_000
        ? ["arraybuffer", "stream"]
        : ["arraybuffer"];
    const nodeMeasurements = nodeModes.map((mode) =>
      JSON.parse(runNode(["--expose-gc", nodeParser, path, mode]))
    );

    sampleResults.push({
      ...sample,
      modes: modeResults,
      nodeMeasurements
    });
    process.stdout.write(`已验证 ${sample.filename}\n`);
  }

  const successfulModeResults = sampleResults.flatMap((sample) => sample.modes);
  const largeSamples = sampleResults.filter((sample) => sample.rawBytes >= 19_000_000);
  const result = {
    generatedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      wrangler: "4.120.0",
      postalMime: "2.7.6",
      compatibilityDate: "2026-08-08",
      parserOptions: {
        attachmentEncoding: "arraybuffer",
        maxNestingDepth: 64,
        maxHeadersSize: 262144,
        maxRfc822NestingDepth: 5
      }
    },
    samples: sampleResults,
    assessment: {
      correctnessPassed: successfulModeResults.every((mode) => mode.correctnessPassed),
      deterministicPassed: successfulModeResults.every((mode) => mode.deterministic),
      largeSamplesParsed: largeSamples.every((sample) =>
        sample.modes.every((mode) => mode.successfulRounds === mode.rounds)
      ),
      localP95TargetPassed: largeSamples.every((sample) =>
        sample.modes.every((mode) => mode.parseP95Milliseconds <= 5000)
      ),
      healthChecksPassed,
      streamInputSupported: sampleResults
        .find((sample) => sample.id === "large-single-attachment")
        ?.modes.find((mode) => mode.mode === "stream")?.successfulRounds === 5,
      malformedSampleOutcome: (() => {
        const body = sampleResults.find((sample) => sample.id === "malformed")?.modes[0]?.firstResult;
        return body?.success ? "受控接受并尽力解析" : "受控拒绝";
      })(),
      workerPeakMemoryProven: false,
      workerPeakMemoryNote:
        "Worker 运行时不提供精确峰值内存读数；Node.js 独立进程数据只用于相对比较，仍需真实 Cloudflare 复核。"
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
