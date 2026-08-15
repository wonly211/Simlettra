interface Env {
  DB: D1Database;
}

interface Measurement {
  name: string;
  milliseconds: number;
  rowsRead: number;
  rowsWritten: number;
  resultCount: number;
}

type TokenMode = "bigram" | "unigram-bigram";

const chineseCharacter = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

const topics = [
  "家庭共享邮箱预算调整",
  "项目进度安排与会议纪要",
  "旅行计划确认和票务信息",
  "服务器维护窗口与恢复演练",
  "学校活动通知和报名安排",
  "发票报销材料与付款确认",
  "订单配送状态与签收提醒",
  "产品设计评审与问题跟踪",
  "周末聚会安排与采购清单",
  "账户安全提醒与登录核验"
];

const details = [
  "请核对本周数据并在周五之前回复确认",
  "附件名称和收件地址已经完成检查",
  "这封邮件用于验证中文关键词连续匹配",
  "所有成员应当只看到自己有权访问的内容",
  "系统需要保留原始时间和实际投递地址",
  "临时失败可以重试但不能产生重复记录",
  "搜索结果需要同时满足日期和状态条件",
  "邮件正文不会写入运行日志或公开位置",
  "归档星标和已读状态属于当前使用者",
  "备份恢复之后搜索索引可以重新生成"
];

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

function isChinese(value: string): boolean {
  return chineseCharacter.test(value);
}

function tokenizeForSearch(input: string, mode: TokenMode = "bigram"): string {
  const normalized = input.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const tokens: string[] = [];
  let chineseRun = "";
  let latinRun = "";

  const flushChinese = () => {
    if (mode === "unigram-bigram") {
      tokens.push(...chineseRun);
    }
    if (chineseRun.length === 1 && mode === "bigram") {
      tokens.push(chineseRun);
    } else if (chineseRun.length > 1) {
      for (let index = 0; index < chineseRun.length - 1; index += 1) {
        tokens.push(chineseRun.slice(index, index + 2));
      }
    }
    chineseRun = "";
  };

  const flushLatin = () => {
    if (latinRun) {
      tokens.push(latinRun);
      latinRun = "";
    }
  };

  for (const character of normalized) {
    if (isChinese(character)) {
      flushLatin();
      chineseRun += character;
    } else if (/\p{Letter}|\p{Number}/u.test(character)) {
      flushChinese();
      latinRun += character;
    } else {
      flushChinese();
      flushLatin();
    }
  }

  flushChinese();
  flushLatin();
  return tokens.join(" ");
}

function toMatchExpression(input: string): string {
  const tokens = tokenizeForSearch(input)
    .split(" ")
    .filter(Boolean)
    .map((token) => token.replaceAll('"', '""'));

  if (tokens.length === 0) {
    throw new Error("搜索词不能为空");
  }

  return `"${tokens.join(" ")}"`;
}

function toScopedMatchExpression(input: string, scopes: string[]): string {
  const scopeExpression = scopes
    .map((scope) => `scopes : ${scope.replaceAll('"', '""')}`)
    .join(" OR ");
  return `(${scopeExpression}) AND body_tokens : ${toMatchExpression(input)}`;
}

function buildTemplate(index: number, mode: TokenMode): [string, string] {
  const topic = topics[index % topics.length];
  const detail = details[Math.floor(index / topics.length) % details.length];
  const first = Array.from(
    { length: 12 },
    (_, paragraph) => `${topic}。${detail}。这是第${paragraph + 1}段，项目进度需要持续记录并完成权限核验。`
  ).join("");
  const second = Array.from(
    { length: 12 },
    (_, paragraph) => `后续说明${paragraph + 1}：邮件搜索应当快速稳定，家庭成员和小团队可以在授权范围内查看共享信息。`
  ).join("");

  return [tokenizeForSearch(first, mode), tokenizeForSearch(second, mode)];
}

async function prepareData(db: D1Database, mode: TokenMode): Promise<Record<string, unknown>> {
  const userStatements = Array.from({ length: 50 }, (_, index) => {
    const id = index + 1;
    return db
      .prepare("INSERT OR REPLACE INTO users(id, email, display_name) VALUES (?, ?, ?)")
      .bind(id, `user${id}@example.test`, `测试用户${id}`);
  });

  const templateStatements = Array.from({ length: 100 }, (_, index) => {
    const [firstChunk, secondChunk] = buildTemplate(index, mode);
    return db
      .prepare(
        "INSERT OR REPLACE INTO search_templates(id, first_chunk_tokens, second_chunk_tokens) VALUES (?, ?, ?)"
      )
      .bind(index, firstChunk, secondChunk);
  });

  await db.batch(userStatements);
  await db.batch(templateStatements);
  await db.prepare(
    `WITH digits(value) AS (
       VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
     ), numbers(value) AS (
       SELECT 1 + a.value + b.value * 10 + c.value * 100 + d.value * 1000 + e.value * 10000
       FROM digits a
       CROSS JOIN digits b
       CROSS JOIN digits c
       CROSS JOIN digits d
       CROSS JOIN digits e
     )
     INSERT OR IGNORE INTO seed_numbers(value)
     SELECT value FROM numbers WHERE value <= 100000`
  ).run();

  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM search_templates) AS templates,
         (SELECT COUNT(*) FROM seed_numbers) AS numbers`
    )
    .first();

  return { mode, ...(counts ?? {}) };
}

async function seedRange(db: D1Database, start: number, count: number): Promise<Record<string, unknown>> {
  const end = Math.min(100000, start + count - 1);
  if (!Number.isInteger(start) || !Number.isInteger(count) || start < 1 || count < 1 || start > 100000) {
    throw new Error("种子范围无效");
  }

  const statements = [
    db.prepare(
      `INSERT OR IGNORE INTO messages(
         id, message_key, subject, sender_address, recipient_address,
         sent_at, has_attachment, template_id
       )
       SELECT
         value,
         printf('message-%06d', value),
         CASE value % 10
           WHEN 0 THEN '家庭共享邮箱预算调整'
           WHEN 1 THEN '项目进度安排与会议纪要'
           WHEN 2 THEN '旅行计划确认和票务信息'
           WHEN 3 THEN '服务器维护窗口与恢复演练'
           WHEN 4 THEN '学校活动通知和报名安排'
           WHEN 5 THEN '发票报销材料与付款确认'
           WHEN 6 THEN '订单配送状态与签收提醒'
           WHEN 7 THEN '产品设计评审与问题跟踪'
           WHEN 8 THEN '周末聚会安排与采购清单'
           ELSE '账户安全提醒与登录核验'
         END || ' #' || printf('%06d', value),
         'sender' || ((value - 1) % 200 + 1) || '@outside.test',
         'user' || ((value - 1) % 50 + 1) || '@example.test',
         1735689600 + value * 60,
         CASE WHEN value % 5 = 0 THEN 1 ELSE 0 END,
         value % 100
       FROM seed_numbers
       WHERE value BETWEEN ? AND ?`
    ).bind(start, end),
    db.prepare(
      `INSERT OR IGNORE INTO mailbox_entries(
         id, message_id, user_id, actual_address, direction
       )
       SELECT
         value * 2,
         value,
         ((value - 1) % 50) + 1,
         'user' || (((value - 1) % 50) + 1) || '@example.test',
         'inbound'
       FROM seed_numbers
       WHERE value BETWEEN ? AND ?`
    ).bind(start, end),
    db.prepare(
      `INSERT OR IGNORE INTO mailbox_entries(
         id, message_id, user_id, actual_address, direction
       )
       SELECT
         value * 2 + 1,
         value,
         ((value + 6) % 50) + 1,
         'shared@example.test',
         'inbound'
       FROM seed_numbers
       WHERE value BETWEEN ? AND ? AND value % 10 = 0`
    ).bind(start, end),
    db.prepare(
      `INSERT OR IGNORE INTO mailbox_states(
         mailbox_entry_id, user_id, is_read, is_starred, is_archived, trashed_at
       )
       SELECT
         id,
         user_id,
         CASE WHEN message_id % 3 = 0 THEN 0 ELSE 1 END,
         CASE WHEN message_id % 17 = 0 THEN 1 ELSE 0 END,
         CASE WHEN message_id % 11 = 0 THEN 1 ELSE 0 END,
         CASE WHEN message_id % 37 = 0 THEN 1735689600 + message_id * 60 ELSE NULL END
       FROM mailbox_entries
       WHERE message_id BETWEEN ? AND ?`
    ).bind(start, end),
    db.prepare(
      `INSERT OR IGNORE INTO search_chunks(id, message_id, chunk_index)
       SELECT value * 2, value, 0
       FROM seed_numbers
       WHERE value BETWEEN ? AND ?`
    ).bind(start, end),
    db.prepare(
      `INSERT OR IGNORE INTO search_chunks(id, message_id, chunk_index)
       SELECT value * 2 + 1, value, 1
       FROM seed_numbers
       WHERE value BETWEEN ? AND ?`
    ).bind(start, end),
    db.prepare(
      `INSERT INTO message_search(rowid, subject, participants, attachment_names, body_tokens, scopes)
       SELECT
         chunks.id,
         messages.subject,
         messages.sender_address || ' ' || messages.recipient_address,
         CASE WHEN messages.has_attachment = 1 THEN '会议纪要.pdf 报销凭证.jpg' ELSE '' END,
         CASE WHEN chunks.chunk_index = 0
           THEN templates.first_chunk_tokens
           ELSE templates.second_chunk_tokens
         END,
         'user' || printf('%04d', ((messages.id - 1) % 50) + 1) ||
           CASE WHEN messages.id % 10 = 0 THEN ' org0001' ELSE '' END
       FROM search_chunks chunks
       JOIN messages ON messages.id = chunks.message_id
       JOIN search_templates templates ON templates.id = messages.template_id
       WHERE messages.id BETWEEN ? AND ?
       ORDER BY chunks.id`
    ).bind(start, end)
  ];

  const before = performance.now();
  const results = await db.batch(statements);
  const milliseconds = performance.now() - before;

  return {
    start,
    end,
    count: end - start + 1,
    milliseconds,
    rowsWritten: results.reduce((total, result) => total + (result.meta.rows_written ?? 0), 0)
  };
}

async function runProbe(db: D1Database, mode: TokenMode): Promise<Record<string, unknown>> {
  const sample = "项目预算调整已经通过，家庭成员可以查看共享邮箱。";
  const candidateSample = tokenizeForSearch(sample, mode);

  await db.batch([
    db.prepare("DELETE FROM probe_unicode"),
    db.prepare("DELETE FROM probe_bigram"),
    db.prepare("INSERT INTO probe_unicode(rowid, body) VALUES (1, ?)").bind(sample),
    db.prepare("INSERT INTO probe_bigram(rowid, body) VALUES (1, ?)").bind(candidateSample)
  ]);

  const unicodePartial = await db
    .prepare("SELECT COUNT(*) AS count FROM probe_unicode WHERE probe_unicode MATCH ?")
    .bind("预算调整")
    .first<number>("count");
  const bigramTwoCharacters = await db
    .prepare("SELECT COUNT(*) AS count FROM probe_bigram WHERE probe_bigram MATCH ?")
    .bind(toMatchExpression("预算"))
    .first<number>("count");
  const bigramFourCharacters = await db
    .prepare("SELECT COUNT(*) AS count FROM probe_bigram WHERE probe_bigram MATCH ?")
    .bind(toMatchExpression("预算调整"))
    .first<number>("count");
  const bigramSingleCharacter = await db
    .prepare("SELECT COUNT(*) AS count FROM probe_bigram WHERE probe_bigram MATCH ?")
    .bind(toMatchExpression("预"))
    .first<number>("count");

  let trigram: Record<string, unknown>;
  try {
    await db.prepare("DROP TABLE IF EXISTS probe_trigram").run();
    await db
      .prepare("CREATE VIRTUAL TABLE probe_trigram USING fts5(body, tokenize='trigram')")
      .run();
    await db.prepare("INSERT INTO probe_trigram(rowid, body) VALUES (1, ?)").bind(sample).run();
    const fourCharacters = await db
      .prepare("SELECT COUNT(*) AS count FROM probe_trigram WHERE probe_trigram MATCH ?")
      .bind("预算调整")
      .first<number>("count");
    const twoCharacters = await db
      .prepare("SELECT COUNT(*) AS count FROM probe_trigram WHERE probe_trigram MATCH ?")
      .bind("预算")
      .first<number>("count");
    trigram = { supported: true, fourCharacters, twoCharacters };
  } catch (error) {
    trigram = {
      supported: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  return {
    mode,
    sample,
    unicode61: { partialFourCharacters: unicodePartial },
    applicationTokens: {
      twoCharacters: bigramTwoCharacters,
      fourCharacters: bigramFourCharacters,
      singleCharacter: bigramSingleCharacter
    },
    trigram
  };
}

async function measure(
  name: string,
  statement: D1PreparedStatement
): Promise<Measurement> {
  const before = performance.now();
  const result = await statement.all();
  return {
    name,
    milliseconds: performance.now() - before,
    rowsRead: result.meta.rows_read ?? 0,
    rowsWritten: result.meta.rows_written ?? 0,
    resultCount: result.results.length
  };
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index] ?? 0;
}

async function runBenchmark(db: D1Database, rounds: number): Promise<Record<string, unknown>> {
  const measurements: Measurement[] = [];

  for (let round = 0; round < rounds; round += 1) {
    measurements.push(
      await measure(
        "收件箱列表",
        db.prepare(
          `SELECT messages.id, messages.subject, messages.sender_address, messages.sent_at,
                  states.is_read, states.is_starred, messages.has_attachment
           FROM mailbox_entries entries
           JOIN mailbox_states states ON states.mailbox_entry_id = entries.id
           JOIN messages ON messages.id = entries.message_id
           WHERE entries.user_id = ? AND states.trashed_at IS NULL AND states.is_archived = 0
           ORDER BY entries.message_id DESC
           LIMIT 50`
        ).bind(1)
      )
    );
    measurements.push(
      await measure(
        "未读筛选",
        db.prepare(
          `SELECT messages.id, messages.subject, messages.sender_address, messages.sent_at
           FROM mailbox_states states
           JOIN mailbox_entries entries ON entries.id = states.mailbox_entry_id
           JOIN messages ON messages.id = entries.message_id
           WHERE states.user_id = ? AND states.is_read = 0 AND states.trashed_at IS NULL
           ORDER BY entries.message_id DESC
           LIMIT 50`
        ).bind(1)
      )
    );
    measurements.push(
      await measure(
        "附件筛选",
        db.prepare(
          `SELECT messages.id, messages.subject, messages.sender_address, messages.sent_at
           FROM mailbox_entries entries
           JOIN mailbox_states states ON states.mailbox_entry_id = entries.id
           JOIN messages ON messages.id = entries.message_id
           WHERE entries.user_id = ? AND states.trashed_at IS NULL AND messages.has_attachment = 1
           ORDER BY entries.message_id DESC
           LIMIT 50`
        ).bind(5)
      )
    );
    measurements.push(
      await measure(
        "中文正文常见词搜索（未使用范围词元）",
        db.prepare(
          `SELECT DISTINCT messages.id, messages.subject, messages.sender_address, messages.sent_at
           FROM message_search
           JOIN search_chunks ON search_chunks.id = message_search.rowid
           JOIN messages ON messages.id = search_chunks.message_id
           JOIN mailbox_entries entries ON entries.message_id = messages.id
           JOIN mailbox_states states ON states.mailbox_entry_id = entries.id
           WHERE message_search MATCH ?
             AND entries.user_id = ?
             AND states.trashed_at IS NULL
           ORDER BY messages.id DESC
           LIMIT 50`
        ).bind(toMatchExpression("项目进度"), 1)
      )
    );
    measurements.push(
      await measure(
        "中文正文常见词搜索（范围词元）",
        db.prepare(
          `SELECT DISTINCT messages.id, messages.subject, messages.sender_address, messages.sent_at
           FROM message_search
           JOIN search_chunks ON search_chunks.id = message_search.rowid
           JOIN messages ON messages.id = search_chunks.message_id
           JOIN mailbox_entries entries ON entries.message_id = messages.id
           JOIN mailbox_states states ON states.mailbox_entry_id = entries.id
           WHERE message_search MATCH ?
             AND entries.user_id = ?
             AND states.trashed_at IS NULL
           ORDER BY messages.id DESC
           LIMIT 50`
        ).bind(toScopedMatchExpression("项目进度", ["user0001"]), 1)
      )
    );
    measurements.push(
      await measure(
        "中文正文较少词搜索（范围词元）",
        db.prepare(
          `SELECT DISTINCT messages.id, messages.subject, messages.sender_address, messages.sent_at
           FROM message_search
           JOIN search_chunks ON search_chunks.id = message_search.rowid
           JOIN messages ON messages.id = search_chunks.message_id
           JOIN mailbox_entries entries ON entries.message_id = messages.id
           JOIN mailbox_states states ON states.mailbox_entry_id = entries.id
           WHERE message_search MATCH ?
             AND entries.user_id = ?
             AND messages.has_attachment = 1
             AND states.is_archived = 0
             AND states.trashed_at IS NULL
           ORDER BY messages.id DESC
           LIMIT 50`
        ).bind(toScopedMatchExpression("预算调整", ["user0010"]), 10)
      )
    );
    measurements.push(
      await measure(
        "发件人和日期组合",
        db.prepare(
          `SELECT messages.id, messages.subject, messages.sender_address, messages.sent_at
           FROM messages
           JOIN mailbox_entries entries ON entries.message_id = messages.id
           JOIN mailbox_states states ON states.mailbox_entry_id = entries.id
           WHERE entries.user_id = ?
             AND messages.sender_address = ?
             AND messages.sent_at BETWEEN ? AND ?
             AND states.trashed_at IS NULL
           ORDER BY messages.sent_at DESC
           LIMIT 50`
        ).bind(1, "sender1@outside.test", 1735689600, 1741689600)
      )
    );
  }

  const byName: Record<string, Measurement[]> = {};
  for (const item of measurements) {
    (byName[item.name] ??= []).push(item);
  }

  return Object.fromEntries(
    Object.entries(byName).map(([name, items]) => [
      name,
      {
        rounds: items.length,
        minimumMilliseconds: Math.min(...items.map((item) => item.milliseconds)),
        medianMilliseconds: percentile(items.map((item) => item.milliseconds), 0.5),
        p95Milliseconds: percentile(items.map((item) => item.milliseconds), 0.95),
        maximumMilliseconds: Math.max(...items.map((item) => item.milliseconds)),
        maximumRowsRead: Math.max(...items.map((item) => item.rowsRead)),
        resultCount: items[0]?.resultCount ?? 0
      }
    ])
  );
}

async function getStats(db: D1Database): Promise<Record<string, unknown>> {
  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM messages) AS messages,
         (SELECT COUNT(*) FROM mailbox_entries) AS mailboxEntries,
         (SELECT COUNT(*) FROM mailbox_states) AS mailboxStates,
         (SELECT COUNT(*) FROM search_chunks) AS searchChunks,
         (SELECT COUNT(*) FROM message_search) AS searchRows`
    )
    .first();
  return counts ?? {};
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/health") {
        return json({ ok: true });
      }
      if (url.pathname === "/prepare" && request.method === "POST") {
        const mode = url.searchParams.get("mode") ?? "bigram";
        if (mode !== "bigram" && mode !== "unigram-bigram") {
          return json({ error: "不支持的词元模式" }, 400);
        }
        return json(await prepareData(env.DB, mode));
      }
      if (url.pathname === "/seed" && request.method === "POST") {
        const start = Number(url.searchParams.get("start") ?? "1");
        const count = Number(url.searchParams.get("count") ?? "10000");
        return json(await seedRange(env.DB, start, count));
      }
      if (url.pathname === "/probe") {
        const mode = url.searchParams.get("mode") ?? "bigram";
        if (mode !== "bigram" && mode !== "unigram-bigram") {
          return json({ error: "不支持的词元模式" }, 400);
        }
        return json(await runProbe(env.DB, mode));
      }
      if (url.pathname === "/benchmark") {
        const rounds = Math.min(100, Math.max(1, Number(url.searchParams.get("rounds") ?? "20")));
        return json(await runBenchmark(env.DB, rounds));
      }
      if (url.pathname === "/stats") {
        return json(await getStats(env.DB));
      }

      return json({ error: "未找到原型接口" }, 404);
    } catch (error) {
      return json(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        },
        500
      );
    }
  }
} satisfies ExportedHandler<Env>;
