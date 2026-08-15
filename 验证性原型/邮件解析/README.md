# 接近 20 MB 邮件解析验证原型

## 目的

本原型在本地 workerd 中使用 `postal-mime` 解析合成邮件，验证正文、附件、邮件关系、异常结构、耗时和近似内存代价。

该目录不属于生产工程骨架，不读取真实邮件。

## 执行

```powershell
pnpm install
pnpm run check
pnpm run validate
```

验证命令会生成 `.generated/` 合成邮件，启动本地 Worker，重复解析大附件、大正文、大量部件和恶意嵌套等九类样本，并写出 `验证结果.json`。

## 重要区别

旧系统把 `ReadableStream` 的分块逐段解码并拼成 JavaScript 字符串，再交给解析器。这可能破坏二进制内容，也会制造额外内存副本。本原型只允许把原始字节、`ArrayBuffer` 或解析器明确支持的流传入 MIME 解析器。

本地成功只能证明候选实现具有继续验证的价值，不能替代真实 Cloudflare Worker 的 CPU 和内存复核。
