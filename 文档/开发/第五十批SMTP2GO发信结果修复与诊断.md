# 第五十批 SMTP2GO 发信结果修复与诊断

## 问题

SMTP2GO 已经接受并投递邮件时，Simlettra 的发信结果仍可能显示“结果待确认”。原实现只读取一种响应结构，未兼容 SMTP2GO 返回的 `email_response.email_id`。

## 修复

1. 兼容 SMTP2GO 的 `data`、`data.email_response` 和 `email_response` 响应结构。
2. 发送请求启用 `fastaccept`，让提交结果尽快返回并由回调继续更新投递状态。
3. 发信结果接口增加 Queue 状态、Queue 错误代码、实际 Provider、Provider 请求结果、`email_id` 和 Provider 错误代码。
4. Queue 异常日志只记录任务编号、版本和错误类型，不记录邮件正文、附件、收件人完整地址或密钥。

## 结果含义

- “已接受”：Provider 已返回提交编号，邮件进入 Provider 处理流程。
- “明确拒绝”：Provider 明确拒绝本次请求，系统可以按既定路线尝试备用服务。
- “结果未知”：请求超时、网络异常或响应缺少提交编号，系统不会自动重发，以避免重复投递。
- Queue 状态与 Provider 请求结果分开显示，便于判断是队列未执行、Provider 未接受，还是已经提交但等待投递回调。

## Queue 入队失败修复

此前发送接口会吞掉 `TASK_QUEUE` 的入队异常，导致 HTTP 接口仍返回“已接受”，但 D1 中的任务一直停留在 `pending`，SMTP2GO 没有任何 Activity。现在改为使用 `sendBatch` 唤醒任务；若 Queue 绑定缺失或入队失败，任务仍保留为可补投的 `pending`，同时写入 `queue_binding_missing` 或 `queue_enqueue_failed`，发送结果页会显示 Queue 错误。日志只记录任务数量和错误类型，不记录邮件内容、完整收件人或密钥。

部署后检查发送结果时，先看 Queue：`pending + queue_binding_missing/queue_enqueue_failed` 表示请求尚未进入 Queue；`running`、`retry_wait` 或 `needs_attention` 表示 Queue 已消费但任务执行或配置仍需检查；只有出现 Provider 和 `email_id` 后，才说明 SMTP2GO 已收到提交请求。`fastaccept` 只代表 SMTP2GO 接受后台处理，不等于最终送达，最终状态仍依赖 SMTP2GO Webhook。

## 验证

- SMTP2GO 响应解析单元测试：4/4 通过。
- 域外发信集成测试：2/2 通过。
- 正式发信 HTTP 集成测试：3/3 通过。
- 全量测试：57 个测试文件、239 项测试通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。

说明：本地 Wrangler 在受限环境中无法写入用户目录日志文件，但不影响上述检查退出成功。
