# 0029 以 Workers Free 作为首发核心运行基线

## 状态

已接受

- 提议与接受日期：2026-08-11
- 需求依据：[需求变更-0003：以 Cloudflare 免费额度作为产品资源上限](../需求/变更记录/0003-以Cloudflare免费额度作为产品资源上限.md)
- 取代关系：取代 ADR [0006 区分存储免费额度与完整功能零费用](0006-区分存储免费额度与完整功能零费用.md) 中允许 Workers Paid 成为首发核心功能必要条件的部分结论
- 官方依据：[Workers 平台限制](https://developers.cloudflare.com/workers/platform/limits/)、[Queues 平台限制](https://developers.cloudflare.com/queues/platform/limits/)、[Queues 定价](https://developers.cloudflare.com/queues/platform/pricing/)

## 背景

Simlettra 的产品目标是使用 Cloudflare 免费资源搭建个人优先、兼顾家庭和小团队的小型邮件系统。D1、KV 和 R2 免费额度已经确定为产品硬上限，但旧 ADR `0006` 没有承诺核心功能可在 Workers Free 上运行。

2026-08-11 复核官方资料后确认：Workers Free 普通 HTTP 请求的 CPU 时间仍然很小，但 Queues 在 Free 计划可用，Queue consumer 的 CPU 时间与普通 HTTP 请求使用不同边界。收信后的 MIME 解析、发信、通知、转发、清理和对账本来就由 Queue consumer 唤醒，因此不能再把普通 HTTP 请求的 CPU 限制直接套用到全部后台工作。

## 决定

1. 首发默认部署必须以 Workers Free 完成初始化、登录、收信入口、读信、搜索、基本站外发信、组织共享和管理闭环。
2. Workers Paid 只能作为可选增强或验证失败后的候选方案，不能成为首发安装、收信、读信、搜索或基本发信的预设条件。
3. D1、KV、R2、Queues 和 Worker 请求均建立免费额度预算、用量观察、保守停止和发布前复核；不把当前数值硬编码成永远不变的产品常量。
4. HTTP 请求只完成轻量鉴权、校验、权威状态写入和任务登记；可延后的重工作继续由 Queue consumer 和分批任务执行。
5. 免费额度达到产品上限时停止新增用量，不删除已有数据，也不阻止阅读、导出、备份和永久删除。
6. 外部 Provider 的套餐与 Cloudflare Workers 计划分开说明；Resend 或 SMTP2GO 的账号条件不能被描述为 Cloudflare 资源额度。
7. 尚未在真实 Workers Free 环境验证通过的高成本能力必须明确标记，不能用“架构上可能可行”代替验收证据。

## 备选方案

1. 继续允许 Workers Paid 作为完整首发能力的默认前提：不符合免费资源产品目标，不采用。
2. 为保证免费而立即降低全部功能上限：会在没有真实验证前削减已经确认的需求，不采用。
3. 同时维护 Free 与 Paid 两套核心架构：会扩大个人项目的实现和测试成本；首发只维护同一架构，Paid 仅改变额度和可选参数。

## 后果

### 正面

1. 默认部署方式与产品初衷一致。
2. 重工作集中在可重试的异步边界，HTTP 请求更容易控制成本和失败面。
3. Paid 不再成为未经用户理解的隐藏前提。

### 负面

1. 所有核心路径都需要真实 Workers Free 验证，不能只在本地或 Paid 环境通过。
2. Queue 免费操作、CPU、内存和并发可能迫使任务进一步分批。
3. 若已确认能力无法在 Free 上可靠实现，必须重新向用户提交产品取舍。

## 验证方式

1. 在全新 Workers Free 账号完成从初始化到多人共享收发邮件的验收。
2. 记录 HTTP、Queue、D1、KV/R2 的实际用量与峰值，不发生未说明的付费用量。
3. 验证达到免费额度停止值后，新增被拒绝而已有数据仍可读取、导出、备份和删除。
4. 发布说明明确列出当前免费额度、统计范围、验证日期和仍未验证的高成本能力。
