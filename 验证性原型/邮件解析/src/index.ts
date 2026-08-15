import PostalMime, { type Attachment, type RawEmail } from "postal-mime";

const parserOptions = {
  attachmentEncoding: "arraybuffer" as const,
  maxNestingDepth: 64,
  maxHeadersSize: 256 * 1024,
  maxRfc822NestingDepth: 5
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

function contentBytes(content: Attachment["content"]): Uint8Array {
  if (typeof content === "string") {
    return new TextEncoder().encode(content);
  }
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }
  return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
}

async function sha256(content: Uint8Array): Promise<string> {
  const input = content.byteOffset === 0 && content.byteLength === content.buffer.byteLength
    ? content.buffer
    : content.slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", input as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function summarizeAttachments(attachments: Attachment[]) {
  const result = [];
  for (const attachment of attachments) {
    const bytes = contentBytes(attachment.content);
    result.push({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      disposition: attachment.disposition,
      related: attachment.related ?? false,
      contentId: attachment.contentId,
      rfc822DepthExceeded: attachment.rfc822DepthExceeded ?? false,
      size: bytes.byteLength,
      sha256: await sha256(bytes)
    });
  }
  return result;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (url.pathname !== "/parse" || request.method !== "POST") {
      return json({ error: "未找到原型接口" }, 404);
    }

    const inputMode = url.searchParams.get("mode") === "stream" ? "stream" : "arraybuffer";
    const declaredBytes = Number(request.headers.get("content-length") ?? "0");
    if (declaredBytes > 21 * 1024 * 1024) {
      return json({ error: "原型拒绝超过 21 MiB 的请求", declaredBytes }, 413);
    }

    try {
      const inputStarted = performance.now();
      const input: RawEmail = inputMode === "stream"
        ? request.body ?? new Uint8Array()
        : await request.arrayBuffer();
      const inputMilliseconds = performance.now() - inputStarted;

      const parseStarted = performance.now();
      const parsed = await PostalMime.parse(input, parserOptions);
      const parseMilliseconds = performance.now() - parseStarted;

      const hashStarted = performance.now();
      const attachments = await summarizeAttachments(parsed.attachments);
      const hashMilliseconds = performance.now() - hashStarted;

      return json({
        success: true,
        inputMode,
        declaredBytes,
        inputMilliseconds,
        parseMilliseconds,
        hashMilliseconds,
        totalMilliseconds: inputMilliseconds + parseMilliseconds + hashMilliseconds,
        summary: {
          subject: parsed.subject,
          messageId: parsed.messageId,
          inReplyTo: parsed.inReplyTo,
          references: parsed.references,
          from: parsed.from,
          to: parsed.to,
          cc: parsed.cc,
          textCharacters: parsed.text?.length ?? 0,
          textStart: parsed.text?.slice(0, 120) ?? "",
          textEnd: parsed.text?.slice(-120) ?? "",
          htmlCharacters: parsed.html?.length ?? 0,
          htmlStart: parsed.html?.slice(0, 160) ?? "",
          attachmentCount: attachments.length,
          totalAttachmentBytes: attachments.reduce((total, attachment) => total + attachment.size, 0),
          attachments
        }
      });
    } catch (error) {
      return json(
        {
          success: false,
          inputMode,
          declaredBytes,
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error)
        },
        422
      );
    }
  }
} satisfies ExportedHandler;
