import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import PostalMime from "postal-mime";

const path = process.argv[2];
const mode = process.argv[3] === "stream" ? "stream" : "arraybuffer";
if (!path) {
  throw new Error("缺少邮件样本路径");
}

globalThis.gc?.();
const before = process.memoryUsage();
let peakRss = before.rss;
let peakHeapUsed = before.heapUsed;
let peakExternal = before.external;
let peakArrayBuffers = before.arrayBuffers;
const timer = setInterval(() => {
  const current = process.memoryUsage();
  peakRss = Math.max(peakRss, current.rss);
  peakHeapUsed = Math.max(peakHeapUsed, current.heapUsed);
  peakExternal = Math.max(peakExternal, current.external);
  peakArrayBuffers = Math.max(peakArrayBuffers, current.arrayBuffers);
}, 1);

const file = await stat(path);
const input = mode === "stream"
  ? Readable.toWeb(createReadStream(path, { highWaterMark: 64 * 1024 }))
  : await readFile(path).then((raw) => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const started = performance.now();
const parsed = await PostalMime.parse(input, {
  attachmentEncoding: "arraybuffer",
  maxNestingDepth: 64,
  maxHeadersSize: 256 * 1024,
  maxRfc822NestingDepth: 5
});
const milliseconds = performance.now() - started;
clearInterval(timer);

const after = process.memoryUsage();
peakRss = Math.max(peakRss, after.rss);
peakHeapUsed = Math.max(peakHeapUsed, after.heapUsed);
peakExternal = Math.max(peakExternal, after.external);
peakArrayBuffers = Math.max(peakArrayBuffers, after.arrayBuffers);

process.stdout.write(
  `${JSON.stringify({
    mode,
    rawBytes: file.size,
    milliseconds,
    attachmentCount: parsed.attachments.length,
    textCharacters: parsed.text?.length ?? 0,
    beforeRssBytes: before.rss,
    afterRssBytes: after.rss,
    peakRssBytes: peakRss,
    peakHeapUsedBytes: peakHeapUsed,
    peakExternalBytes: peakExternal,
    peakArrayBuffersBytes: peakArrayBuffers,
    resourceUsageMaximumRss: process.resourceUsage().maxRSS
  })}\n`
);
