import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(root, ".generated");
const crlf = "\r\n";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function encodedWord(value) {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function deterministicBytes(size, seed) {
  const value = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index += 1) {
    value[index] = (index * 31 + seed * 17 + (index >>> 8)) & 0xff;
  }
  return value;
}

function wrapBase64(content) {
  const encoded = content.toString("base64");
  const lines = [];
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76));
  }
  return lines.join(crlf);
}

function commonHeaders(subject, messageId) {
  return [
    `From: ${encodedWord("澄笺测试发送者")} <sender@example.test>`,
    `To: ${encodedWord("澄笺测试用户")} <receiver@example.test>`,
    "Cc: family@example.test",
    `Subject: ${encodedWord(subject)}`,
    `Message-ID: <${messageId}@example.test>`,
    "In-Reply-To: <parent-message@example.test>",
    "References: <root-message@example.test> <parent-message@example.test>",
    "Date: Mon, 10 Aug 2026 12:00:00 +0800",
    "MIME-Version: 1.0"
  ];
}

function attachmentPart(boundary, attachment, index) {
  const filename = attachment.filename;
  const encodedFilename = encodeURIComponent(filename);
  const lines = [
    `--${boundary}`,
    `Content-Type: ${attachment.mimeType}; name*=UTF-8''${encodedFilename}`,
    "Content-Transfer-Encoding: base64",
    `${attachment.disposition ?? "attachment"}; filename*=UTF-8''${encodedFilename}`
      .replace(/^/, "Content-Disposition: ")
  ];
  if (attachment.contentId) {
    lines.push(`Content-ID: <${attachment.contentId}>`);
  }
  lines.push(
    "",
    wrapBase64(attachment.content),
    ""
  );
  return lines.join(crlf) + crlf + (index < 0 ? "" : "");
}

function buildStandardSample() {
  const outer = "simlettra-standard-outer";
  const related = "simlettra-standard-related";
  const alternative = "simlettra-standard-alternative";
  const inlineContent = deterministicBytes(4096, 1);
  const attachmentContent = Buffer.from("这是用于校验附件名称和内容哈希的合成文件。\n", "utf8");
  const lines = [
    ...commonHeaders("标准 MIME 功能验证", "standard"),
    `Content-Type: multipart/mixed; boundary="${outer}"`,
    "",
    `--${outer}`,
    `Content-Type: multipart/related; boundary="${related}"`,
    "",
    `--${related}`,
    `Content-Type: multipart/alternative; boundary="${alternative}"`,
    "",
    `--${alternative}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    "这是一封用于验证澄笺邮件解析的纯文本正文。",
    `--${alternative}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    "<p>这是一封用于验证<strong>澄笺</strong>邮件解析的 HTML 正文。</p><img src=\"cid:logo@simlettra.test\">",
    `--${alternative}--`,
    "",
    attachmentPart(
      related,
      {
        filename: "澄笺标识.png",
        mimeType: "image/png",
        disposition: "inline",
        contentId: "logo@simlettra.test",
        content: inlineContent
      },
      0
    ),
    `--${related}--`,
    "",
    attachmentPart(
      outer,
      {
        filename: "账单 2026.txt",
        mimeType: "text/plain",
        disposition: "attachment",
        content: attachmentContent
      },
      0
    ),
    `--${outer}--`,
    ""
  ];

  return {
    raw: Buffer.from(lines.join(crlf), "utf8"),
    expected: {
      subject: "标准 MIME 功能验证",
      messageId: "<standard@example.test>",
      textIncludes: "澄笺邮件解析",
      htmlIncludes: "<strong>澄笺</strong>",
      attachments: [
        {
          filename: "澄笺标识.png",
          size: inlineContent.length,
          sha256: sha256(inlineContent),
          contentId: "logo@simlettra.test"
        },
        {
          filename: "账单 2026.txt",
          size: attachmentContent.length,
          sha256: sha256(attachmentContent)
        }
      ]
    }
  };
}

function buildAttachmentMessage(subject, messageId, attachments) {
  const boundary = `simlettra-${messageId}-boundary`;
  const sections = [
    ...commonHeaders(subject, messageId),
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    `这是 ${subject} 的合成正文。`,
    ""
  ];

  attachments.forEach((attachment, index) => {
    sections.push(attachmentPart(boundary, attachment, index));
  });
  sections.push(`--${boundary}--`, "");

  return Buffer.from(sections.join(crlf), "utf8");
}

function fitAttachmentMessage(targetBytes, count, subject, messageId) {
  let totalDecodedBytes = Math.floor(targetBytes * 0.72);
  let result;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const baseSize = Math.floor(totalDecodedBytes / count);
    const attachments = Array.from({ length: count }, (_, index) => {
      const size = index === count - 1 ? totalDecodedBytes - baseSize * (count - 1) : baseSize;
      return {
        filename: count === 1 ? "大型附件.bin" : `分卷附件-${String(index + 1).padStart(2, "0")}.bin`,
        mimeType: "application/octet-stream",
        disposition: "attachment",
        content: deterministicBytes(size, index + 11)
      };
    });
    const raw = buildAttachmentMessage(subject, messageId, attachments);
    result = { raw, attachments };
    const difference = targetBytes - raw.length;
    if (Math.abs(difference) < 4096) {
      break;
    }
    totalDecodedBytes = Math.max(count, totalDecodedBytes + Math.floor(difference * 0.72));
  }

  if (!result || result.raw.length > targetBytes) {
    throw new Error(`无法把 ${subject} 调整到目标大小以内`);
  }

  return {
    raw: result.raw,
    expected: {
      subject,
      messageId: `<${messageId}@example.test>`,
      attachments: result.attachments.map((attachment) => ({
        filename: attachment.filename,
        size: attachment.content.length,
        sha256: sha256(attachment.content)
      }))
    }
  };
}

function buildLargeTextSample(targetBytes) {
  const headers = Buffer.from(
    [
      ...commonHeaders("接近二十兆字节的纯文本邮件", "large-text"),
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 7bit",
      "",
      "正文开始标记 SIMLETTRA_TEXT_START",
      ""
    ].join(crlf),
    "utf8"
  );
  const footer = Buffer.from(`${crlf}正文结束标记 SIMLETTRA_TEXT_END${crlf}`, "utf8");
  const line = `${"A".repeat(900)}${crlf}`;
  const remaining = targetBytes - headers.length - footer.length;
  const repeatCount = Math.floor(remaining / Buffer.byteLength(line));
  const repeated = line.repeat(repeatCount);
  const paddingLength = remaining - Buffer.byteLength(repeated);
  const padding = "B".repeat(Math.max(0, paddingLength));
  const raw = Buffer.concat([headers, Buffer.from(repeated + padding, "ascii"), footer]);

  return {
    raw,
    expected: {
      subject: "接近二十兆字节的纯文本邮件",
      messageId: "<large-text@example.test>",
      textIncludes: "SIMLETTRA_TEXT_START",
      textEndsWith: "SIMLETTRA_TEXT_END",
      minimumTextCharacters: 19_000_000,
      attachments: []
    }
  };
}

function buildManyPartsSample() {
  const attachments = Array.from({ length: 1000 }, (_, index) => ({
    filename: `小附件-${String(index + 1).padStart(4, "0")}.bin`,
    mimeType: "application/octet-stream",
    disposition: "attachment",
    content: deterministicBytes(512, index + 101)
  }));
  const raw = buildAttachmentMessage("大量 MIME 部件压力验证", "many-parts", attachments);
  return {
    raw,
    expected: {
      subject: "大量 MIME 部件压力验证",
      messageId: "<many-parts@example.test>",
      attachmentCount: attachments.length,
      totalAttachmentBytes: attachments.reduce((total, attachment) => total + attachment.content.length, 0)
    }
  };
}

function buildMalformedSample() {
  const boundary = "simlettra-malformed-boundary";
  const raw = Buffer.from(
    [
      ...commonHeaders("结构异常邮件", "malformed"),
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "这一部分可以读取，但邮件故意缺少结束边界。",
      `--${boundary}`,
      "Content-Type: application/octet-stream",
      "Content-Disposition: attachment; filename=\"..\\..\\异常附件.bin\"",
      "Content-Transfer-Encoding: base64",
      "",
      "%%%这不是合法的Base64%%%"
    ].join(crlf),
    "utf8"
  );
  return {
    raw,
    expected: {
      controlledOutcome: true
    }
  };
}

function buildOversizedHeadersSample() {
  const raw = Buffer.from(
    [
      ...commonHeaders("超大邮件头", "oversized-headers"),
      `X-Simlettra-Oversized: ${"A".repeat(300 * 1024)}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "超大邮件头之后的正文不应进入可见状态。"
    ].join(crlf),
    "utf8"
  );
  return {
    raw,
    expected: {
      mustReject: true,
      errorIncludes: "Maximum header size"
    }
  };
}

function buildDeepMimeNestingSample() {
  const depth = 65;
  const boundaries = Array.from({ length: depth }, (_, index) => `simlettra-depth-${index}`);
  const lines = [
    ...commonHeaders("过深 MIME 嵌套", "deep-mime"),
    `Content-Type: multipart/mixed; boundary="${boundaries[0]}"`,
    ""
  ];

  for (let index = 0; index < depth; index += 1) {
    lines.push(`--${boundaries[index]}`);
    if (index === depth - 1) {
      lines.push("Content-Type: text/plain; charset=utf-8", "", "过深结构中的正文。", "");
    } else {
      lines.push(
        `Content-Type: multipart/mixed; boundary="${boundaries[index + 1]}"`,
        ""
      );
    }
  }
  for (let index = depth - 1; index >= 0; index -= 1) {
    lines.push(`--${boundaries[index]}--`, "");
  }

  return {
    raw: Buffer.from(lines.join(crlf), "utf8"),
    expected: {
      mustReject: true,
      errorIncludes: "Maximum MIME nesting depth"
    }
  };
}

function buildNestedRfc822Sample() {
  const buildMessage = (depth) => {
    const headers = [
      `From: level-${depth}@example.test`,
      "To: receiver@example.test",
      `Subject: RFC822 level ${depth}`,
      `Message-ID: <rfc822-level-${depth}@example.test>`,
      "MIME-Version: 1.0"
    ];
    if (depth === 0) {
      return [...headers, "Content-Type: text/plain; charset=utf-8", "", "最内层正文。", ""].join(crlf);
    }
    return [
      ...headers,
      "Content-Type: message/rfc822",
      "",
      buildMessage(depth - 1)
    ].join(crlf);
  };

  return {
    raw: Buffer.from(buildMessage(7), "utf8"),
    expected: {
      subject: "RFC822 level 7",
      rfc822DepthExceeded: true
    }
  };
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const definitions = [
  {
    id: "standard",
    filename: "标准功能邮件.eml",
    scenario: "标准正文、内嵌资源、附件名和邮件关系",
    rounds: 10,
    ...buildStandardSample()
  },
  {
    id: "large-single-attachment",
    filename: "接近20MB单附件邮件.eml",
    scenario: "接近 20,000,000 字节的单个 Base64 附件",
    rounds: 5,
    ...fitAttachmentMessage(19_900_000, 1, "接近二十兆字节的单附件邮件", "large-single")
  },
  {
    id: "large-multiple-attachments",
    filename: "接近20MiB多附件邮件.eml",
    scenario: "接近 20 MiB 的八个 Base64 附件",
    rounds: 5,
    ...fitAttachmentMessage(20 * 1024 * 1024 - 64 * 1024, 8, "接近二十兆字节的多附件邮件", "large-multiple")
  },
  {
    id: "large-text",
    filename: "接近20MB纯文本邮件.eml",
    scenario: "接近 20,000,000 字节的七位纯文本正文",
    rounds: 5,
    ...buildLargeTextSample(19_900_000)
  },
  {
    id: "many-parts",
    filename: "大量部件邮件.eml",
    scenario: "一千个小附件",
    rounds: 5,
    ...buildManyPartsSample()
  },
  {
    id: "malformed",
    filename: "结构异常邮件.eml",
    scenario: "缺少结束边界并包含异常 Base64",
    rounds: 3,
    ...buildMalformedSample()
  },
  {
    id: "oversized-headers",
    filename: "超大邮件头.eml",
    scenario: "邮件头超过 256 KiB",
    rounds: 3,
    ...buildOversizedHeadersSample()
  },
  {
    id: "deep-mime-nesting",
    filename: "过深MIME嵌套.eml",
    scenario: "MIME 嵌套超过 64 层",
    rounds: 3,
    ...buildDeepMimeNestingSample()
  },
  {
    id: "nested-rfc822",
    filename: "过深RFC822嵌套.eml",
    scenario: "message/rfc822 嵌套超过 5 层",
    rounds: 3,
    ...buildNestedRfc822Sample()
  }
];

const manifest = { generatedAt: new Date().toISOString(), samples: [] };
for (const definition of definitions) {
  const path = resolve(outputDirectory, definition.filename);
  await writeFile(path, definition.raw);
  manifest.samples.push({
    id: definition.id,
    filename: definition.filename,
    scenario: definition.scenario,
    rounds: definition.rounds,
    rawBytes: definition.raw.length,
    rawSha256: sha256(definition.raw),
    expected: definition.expected
  });
  process.stdout.write(`已生成 ${definition.filename}：${definition.raw.length} 字节\n`);
}

await writeFile(
  resolve(outputDirectory, "样本清单.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);
