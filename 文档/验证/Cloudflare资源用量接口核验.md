# 澄笺 | Simlettra Cloudflare 资源用量接口核验

## 文档状态

- 状态：当前，官方资料与产品解释已核验，真实免费账号验证待执行
- 核验日期：2026-08-12
- 适用需求：[需求变更-0002：资源用量与域名月度发件配额](../需求/变更记录/0002-资源用量与域名月度发件配额.md)
- 适用数据模型：[第六批数据模型确认清单](../数据模型/第六批数据模型确认清单.md)
- 资料范围：Cloudflare 官方开发者文档

## 核验目的

确认 Simlettra 能否向系统管理员展示 D1、KV 或 R2 的已用免费额度、免费额度上限和剩余额度，并在预计越过免费额度时阻止新增用量。

## 核验结论

1. D1 官方 REST API 的数据库详情包含 `file_size`，单位为字节，可以作为数据库实际文件大小的首选来源。
2. D1 的平台硬上限与 Workers 计划有关：Free 计划单数据库最大 500 MB、账号总存储最大 5 GB；Paid 计划单数据库最大 10 GB、账号总存储默认最大 1 TB。Simlettra 只采用 Free 计划口径作为产品容量上限。
3. KV 可以通过 GraphQL Analytics API 的 `kvStorageAdaptiveGroups` 获取 `byteCount` 和 `keyCount`。指标最多保留最近 31 天，因此 Simlettra 如需显示较长期趋势，必须自行保存用量快照。
4. KV Free 计划的账号和单命名空间存储硬上限均为 1 GB；Paid 计划存储无固定上限。后者只是平台事实，不属于 Simlettra 的产品可用容量。
5. R2 可以通过 GraphQL Analytics API 的 `r2StorageAdaptiveGroups` 获取对象负载大小、元数据大小、对象数和未完成分片上传数。
6. R2 每个存储桶的总数据容量和对象数量在平台层没有固定上限。标准存储的 10 GB-month 是账号级月度免费包含量；Simlettra 将这份免费包含量作为产品容量上限，不自动进入付费存储。Infrequent Access 存储不适用该免费额度，因此不作为首发免费存储路径。
7. GraphQL Analytics API 推荐使用 Cloudflare API Token，并需要账号级 `Account Analytics: Read` 权限；D1 数据库详情至少需要 `D1 Read` 权限。实现时可以使用同一枚满足两类只读权限的 Token，也可以由管理员分别配置。
8. 如果管理员没有配置 Cloudflare 只读 API Token，或官方接口临时失败，Simlettra 仍可根据自己的对象登记与数据库统计显示估算值，但必须明确标注“估算”、统计范围和最后更新时间。由于本地账本看不到同一 Cloudflare 账号中的其他项目，此时不能保证账号一定不会越过免费额度，必须采用保守停止策略。

## 产品解释

1. Cloudflare 是否允许付费扩容，与 Simlettra 是否允许继续使用是两件不同的事。
2. 对 Simlettra 而言，D1、KV 和 R2 的当前免费额度就是“总容量”。管理页不显示可付费扩展空间，也不提供解除该上限的普通设置。
3. 管理员可以设置比免费额度更低的系统预警值或停止值，但不能通过产品界面把上限提高到免费额度之外。
4. 预计新增邮件、附件、草稿或已发送副本会越过免费额度时，系统必须在增加用量前停止；现有邮件仍可阅读、导出、备份和永久删除。
5. 免费额度通常按 Cloudflare 账号统计。若同一账号还运行其他项目，Simlettra 的真正可用剩余额度必须扣除其他项目已经占用的部分。

## 推荐显示口径

| 资源 | 已用容量首选来源 | Simlettra 显示的总容量 | 补充信息 |
| --- | --- | --- | --- |
| D1 | 数据库详情 API 的 `file_size`，并结合账号级数据库用量 | Free 计划单数据库 500 MB；实际剩余额度还受账号总存储 5 GB 和同账号其他 D1 数据库占用影响 | 同时显示单数据库与账号范围、数据来源和刷新时间 |
| KV | GraphQL 的 `byteCount` | Free 计划 1 GB；实际剩余额度扣除同账号或同命名空间已有占用 | 可显示 `keyCount`，避免逐键扫描计算总量 |
| R2 | GraphQL 的 `payloadSize + metadataSize`，并汇总账号内标准存储 | 标准存储账号级 10 GB-month 免费额度，作为产品容量上限 | 同时显示对象数、未完成分片上传数和账号中其他桶的占用；不启用付费扩容 |

## 凭据保存边界

1. Cloudflare 只读 API Token 由当前系统管理员在网页中管理，普通用户不能访问。
2. Token 按已接受的 ADR `0025` 使用配置加密主密钥加密后保存到 D1；管理员可以查看、复制、替换、删除和测试，不增加针对管理员本人的人为限制。
3. Token 不进入普通日志、审计详情、Queue 消息或备份清单；备份与恢复继续遵守已确认的配置加密主密钥规则。
4. 权限只授予读取 D1 信息和账号分析指标所需范围，不使用 Global API Key 作为推荐方案。

## 实现阶段验证

1. 使用真实的 Workers Free 账号分别查询 D1、KV 和 R2 指标，记录返回字段、数据延迟和零用量表现。
2. 验证 GraphQL 指标在写入和删除对象后的更新时间，确定预警余量和后台刷新频率，避免因指标延迟越过免费额度。
3. 验证 Token 缺失、权限不足、过期、接口限速和 Cloudflare 故障时的保守停止与降级显示。
4. 将 Simlettra 对象登记账本与 Cloudflare 指标进行差异对账，明确估算值包含和排除的对象范围。
5. 在同一 Cloudflare 账号创建非 Simlettra 的 D1、KV 或 R2 用量，验证总览能够扣除共享免费额度，而不是错误地把整份免费额度都留给 Simlettra。
6. 分别验证 D1、KV 和 R2 接近免费额度时，收信、草稿附件、发信副本、阅读、导出、备份和永久删除的产品行为。

## 本地契约实现结果

2026-08-12 已完成本地正式实现与高保真验证：

1. 正式迁移 `0015-免费资源用量与容量预留.sql` 保存加密只读配置、阈值版本、账号与当前资源双口径快照，以及增长前容量预留。
2. 管理接口和每小时定时任务能够在配置 Token 后刷新 D1 与当前 KV/R2 用量；没有 Token 或官方接口失败时保留明确来源和状态，不把本地估算冒充账号真实用量。
3. D1 准入同时检查 Free 账号 5 GB 和当前单数据库 500 MB；KV 同时检查账号与当前命名空间 1 GB；R2 按产品约定同时检查账号与当前存储桶 10 GB。
4. 只使用本地估算时有效停止比例最高为 `80%`，并保留额外安全余量；收信、草稿附件和已发送副本都已接入容量预留。
5. 达到停止线只拒绝新增存储，现有邮件的阅读、导出、备份和永久删除边界保持不变。
6. 桌面与 `390 × 844` 手机管理页面已验证双口径说明、阈值保存、长编号与 Token 输入和无横向溢出，控制台没有警告或错误。

以上结果证明本地数据契约、权限、降级说明和容量准入已经实现，不证明真实 Cloudflare Free 账号的字段、权限组合和指标延迟已经完成上线验证。

## 官方资料

1. [D1 数据库详情 API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/get/)
2. [D1 平台限制](https://developers.cloudflare.com/d1/platform/limits/)
3. [KV 指标与分析](https://developers.cloudflare.com/kv/observability/metrics-analytics/)
4. [KV 平台限制](https://developers.cloudflare.com/kv/platform/limits/)
5. [KV 定价](https://developers.cloudflare.com/kv/platform/pricing/)
6. [R2 指标与分析](https://developers.cloudflare.com/r2/platform/metrics-analytics/)
7. [R2 平台限制](https://developers.cloudflare.com/r2/platform/limits/)
8. [R2 定价](https://developers.cloudflare.com/r2/pricing/)
9. [GraphQL Analytics API Token 配置](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)

## 当前限制

官方资料、产品口径、本地契约和高保真测试已经完成，尚未使用真实 Cloudflare Free 账号调用接口。账号级汇总、权限组合、指标延迟、预警余量、请求成本和异常响应仍需远程验证。R2 的 10 GB-month 是计费口径，如何以保守的瞬时容量限制避免产生存储费用，也必须用真实账号和跨月样本验证。
