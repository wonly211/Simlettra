import { PrismaD1 } from "@prisma/adapter-d1";
import { PrismaClient } from "@prisma/client";

interface Env {
  DB: D1Database;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

async function fetchHandler(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ healthy: true, candidate: "prisma" });
  }
  if (request.method !== "GET" || url.pathname !== "/list") {
    return json({ error: "未找到" }, 404);
  }
  const adapter = new PrismaD1(env.DB);
  const prisma = new PrismaClient({ adapter });
  try {
    const userId = url.searchParams.get("user") ?? "user-owner";
    const rows = await prisma.mailboxEntry.findMany({
      where: {
        userId,
        mailbox: "inbox",
        message: { visibility: "visible" }
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
      select: {
        id: true,
        isRead: true,
        deliveredAddress: { select: { address: true } },
        message: {
          select: {
            id: true,
            subject: true,
            previewText: true,
            receivedAt: true,
            hasAttachments: true
          }
        }
      }
    });
    return json({ rows });
  } finally {
    await prisma.$disconnect();
  }
}

export default { fetch: fetchHandler } satisfies ExportedHandler<Env>;
