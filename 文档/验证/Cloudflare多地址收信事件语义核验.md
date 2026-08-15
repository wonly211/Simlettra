# Cloudflare 多地址收信事件语义核验

## 文档状态

- 状态：当前，官方资料核验完成，真实事件待验证
- 核验日期：2026-08-14
- 核验范围：Cloudflare Email Routing、Email Worker、Workers Free 与 Cloudflare Queues
- 对应需求：`5.04`、`5.05`、`5.12`、`12.05`
- 对应架构：[ADR 0047](../架构决策记录/0047-以内容窗口归并多地址收信并异步补交付.md)

## 核验问题

Simlettra 需要把同一封邮件投递到多个本地地址时只保存一份物理内容，同时让每个有权邮箱看到自己的实际投递。需要确认 Cloudflare 是否公开保证以下行为：

1. Email Worker 收到的是单个实际收件地址还是完整信封收件人集合；
2. 一个 SMTP 事务包含多个本地域名 `RCPT TO` 时会触发一次还是多次 Worker 调用；
3. 多次调用的原始 MIME 字节、顺序、并发和重试身份是否稳定。

## 官方资料可确认的事实

1. [`ForwardableEmailMessage`](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/) 的 `from` 是信封 `MAIL FROM`，`to` 是单个信封 `RCPT TO`，同时提供 `raw` 原始 MIME 流和 `rawSize`。接口没有收件人数组或公开来源事件编号。
2. [Email Routing 规则](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)把一个邮件地址模式映射到一个目标地址或一个 Worker；相同模式建立多条规则时只有列表中的第一条处理来信。
3. [Email Service 限制](https://developers.cloudflare.com/email-service/platform/limits/)当前写明 Email Routing 的入站邮件上限为 25 MiB。Simlettra 的 `20,000,000` 字节产品上限更小，继续作为有效入口上限。
4. 同一限制页明确指出 Email Routing Worker 使用标准 Workers CPU 与内存边界。[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)当前列出 Workers Free 每次调用 10 ms CPU 和 128 MB 内存，因此入口只保存原始对象并登记任务，完整 MIME 解析继续放在 Queue consumer。
5. [Queues 限制](https://developers.cloudflare.com/queues/platform/limits/)允许 Workers Free 使用 Queue，并提供独立的消息、重试、并发和 consumer 执行边界；D1 任务账本与 Cron 补投仍是可靠性事实来源。

## 官方资料没有承诺的行为

截至核验日期，上述官方资料没有说明：

1. 同一个 SMTP 事务的多个 `RCPT TO` 是否必然各触发一次 Email Worker；
2. 多地址调用是否串行、并行或可能延迟到物理邮件已经可见之后；
3. 多次调用的 `raw` 是否逐字节完全相同，Cloudflare 是否会按收件地址改写头部；
4. 平台重试是否提供稳定事件编号，或能否把不同收件地址的调用证明为同一 SMTP 事务；
5. Catch-all、显式地址规则和同一 Worker 组合时，多地址调用是否具有额外去重语义。

因此，不能把“每个收件地址一次调用且原始字节相同”写成已确认平台事实。ADR `0047` 中的多调用描述是基于单值 `to` 接口和产品场景作出的工程推断，最终上线必须以真实 Free 环境证据为准。

## 对当前实现的影响

1. Simlettra 只在一小时窗口内合并信封发件人和原始 MIME SHA-256 完全相同的事件，不使用 `Message-ID` 建立永久唯一约束。
2. 若 Cloudflare 为多个本地收件地址提供相同原始字节，当前实现会得到一个收信操作、一封物理邮件、多条冻结路由和实际投递。
3. 若 Cloudflare 为不同收件地址改写原始字节，当前实现会保守地建立多封物理邮件，不会误把不同内容合并；所有有权用户仍可见，但“不重复保存内容”的验收不通过。
4. 真实验证发现原始字节不一致时，必须停止发布并重新设计关联证据，不能静默改用不可靠的 `Message-ID` 唯一键，也不能把重复内容当作已满足需求。
5. 官方资料不能证明 Queue consumer 能在 Workers Free 中稳定解析接近 20 MB；CPU、内存、并发和重试继续是独立上线门槛。

## 真实验证矩阵

R2 与 KV 模式分别执行，全部使用虚构地址和无敏感内容：

| 场景 | 信封收件地址 | 预期 D1 结果 | 必记平台证据 |
| --- | --- | --- | --- |
| 同一用户多地址 | 主地址、一个个人别名 | 1 个收信操作、1 封物理邮件、1 个个人邮箱条目、2 条实际投递 | Worker 调用数量、时间、两条冻结路由、对象数量 |
| 不同用户 | 两名用户的主地址 | 1 个收信操作、1 封物理邮件、2 个个人邮箱条目、2 条实际投递 | 调用顺序或并发、两名用户可见性、各自逻辑用量 |
| 个人与组织 | 一个个人地址、一个组织地址 | 1 个收信操作、1 封物理邮件、个人与组织各 1 个邮箱条目 | 当前组织成员可见性、独立状态、实际投递 |
| 可见后迟到 | 首地址完成后重放完全相同 MIME 到第二地址 | 1 封物理邮件，`receive_route_commit` 完成第二路由 | 任务建立、Queue 尝试、完成时间、无新增对象 |
| Queue 故障 | 解析和补交付分别中断一次 | 重投或 Cron 推进原任务，不新增邮件或路由 | 任务编号、尝试次数、安全错误代码、最终状态 |
| 接近 20 MB | 上述至少一个多地址场景使用约 19,900,000 字节样本 | 完整可见且无半封、无对象缺失 | Email Handler 与 Queue CPU、内存、重试、总耗时 |

## 通过与停止条件

只有以下条件全部满足，才能关闭验收-06的远程缺口：

1. 三类多地址所有权组合都让全部有权用户看到邮件；
2. 同一原始邮件只形成一封物理邮件和一组内容对象；
3. 每个实际投递地址均可追溯，密送信息没有越权暴露；
4. 首次解析和迟到补交付的 Queue 故障均可恢复且不重复；
5. KV 与 R2 结果一致，接近 20 MB 时仍处于 Workers Free 可接受边界。

出现以下任一情况立即停止并保留脱敏证据：

- Cloudflare 对不同收件地址改写原始字节，导致同一邮件建立多封物理邮件；
- 某个本地收件地址没有 Worker 事件、冻结路由或最终投递；
- Queue 重试新增物理邮件、重复路由、重复通知或重复外部转发；
- Email Handler 或 Queue consumer 超出 CPU、内存、重试或费用边界；
- 为通过验收需要记录正文、附件、真实地址或可重放凭据。

## 结论

本地实现与公开接口形状一致，但官方资料只确认单值信封收件人接口，没有确认多地址事件的完整运行语义。当前结论是“本地方案成立，真实 Cloudflare Free 验证仍为强制发布门槛”，不能提前写成平台兼容已经完成。
