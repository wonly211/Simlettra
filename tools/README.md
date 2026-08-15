# 澄笺本地工具

本目录保存与在线 Worker 运行路径分离的本地工具。旧系统迁移工具默认只读 `E:\SynologyDrive\github\Simletter`。

## 当前工具

- `安全构建.mjs`：生产构建期间把真实 `.dev.vars*` 临时移出项目目录，构建后扫描 `dist` 中的密钥文件名和已知密钥内容，并在成功或失败后恢复本地配置。使用 `--config wrangler.kv.jsonc` 可以生成 KV 模式产物；发现泄漏时会删除整个 `dist` 并使构建失败。
- `本地备份恢复.mjs`：校验管理员下载的原始备份分卷，生成恢复计划，建立或解开默认加密本地容器，并把权威数据恢复到已经应用相同迁移的空白 D1 与空白 KV/R2 资源。
- `本地备份恢复自检.mjs`：验证备份清单、加密认证、外键拓扑、自引用回填、不可处理循环拒绝，以及临时 `D1 + KV`、`D1 + R2` 的完整恢复账本与六项检查。
- `旧系统数据迁移.mjs`：只读提取旧 D1 与旧 KV/R2 中已确认范围的数据，建立稳定快照，并向独立演练目标或正式目标执行可对账、可重放的迁移。
- `旧系统数据迁移自检.mjs`：使用合成旧数据分别验证 KV 和 R2 目标的快照、演练、正式迁移、重复执行、搜索、会话、对账和失败报告。
- `本地升级回退自检.mjs`：从升级前正式迁移重建代表性 D1，应用当前最新迁移，核对既有结构、行数、代表性数据和外键，再从升级前快照建立独立回退目标；不会连接或修改远程资源。
- `本地性能验收.mjs`：应用全部正式 D1 迁移，在临时数据库中建立 50 名用户和 100,000 封邮件，以 10 个独立读取线程重复测量当前收件箱列表和详情授权查询；不连接远程资源。
- `生成源码快照.mjs`：按显式白名单生成开发版源码 ZIP、逐文件清单和外部 SHA-256；排除本地密钥、依赖、构建产物、日志、临时数据库与大邮件样本，并在写出前验证两次生成一致性和解压后逐文件摘要。
- `生成公开部署仓库.mjs`：按部署白名单生成只含 Vue、Worker、正式迁移、Cloudflare 配置与部署说明的公开仓库目录，并检查禁止路径、旧变量名和本地密钥值。
- `Cloudflare连接GitHub构建.mjs`：公开仓库的默认构建入口；本地执行普通安全构建，Workers Builds 中按实际 Worker 项目名称准备资源、生成真实配置并完成 D1 迁移保护。
- `Cloudflare部署资源.mjs`：按 `meta`、`raw`、`tasks` 规则校验资源名称，幂等查找或创建 D1、KV/R2、Queue，并把真实编号和名称写入最终 Wrangler 配置。

## 源码快照

```powershell
pnpm package:source
```

默认写入 `发布制品/`，包括源码 ZIP、外部源码清单和 ZIP 的 `.sha256`。该目录由 `.gitignore` 排除。快照保留正式源码、迁移、测试、配置模板、简体中文文档、验证原型源码和项目级 Skill；`.dev.vars`、`node_modules`、`dist`、日志、TypeScript 增量文件、Miniflare 数据、原型自身忽略的结果文件与生成的大邮件样本不会进入快照。

工具把 `.dev.vars.example` 和 `wrangler.test.jsonc` 中已经公开的测试值视为夹具，只扫描本地配置中除此之外的实际值。命中任一本地密钥、路径集合异常、两次 ZIP 字节不同或解压摘要不一致时立即失败，不写出新的可信结论。

源码快照只证明“这一份文件集合可以被校验和重新取得”，不证明真实 Cloudflare、外部 Provider、浏览器矩阵或真人验收已经通过。正式发布仍需建立正式版本标识并保留上一正式版本。

## 本地性能验收

```powershell
node tools/本地性能验收.mjs
```

工具使用合成个人邮件和空正文对象替代真实邮件内容，只验证正式 D1 结构、索引、列表 SQL 与详情授权 SQL。为了避免为 100,000 封合成邮件写入不参与本次查询的 200,000 个对象登记，临时数据库只移除“就绪邮件插入时校验对象完整性”的触发器；其余正式迁移、外键和查询结构保持不变，结束时删除整个临时目录。

本地通过不能替代真实 Cloudflare Free 验收。Worker 调度、网络延迟、KV/R2 正文读取和浏览器渲染均不在该工具范围内；邮箱查询发生结构变化时，必须同步复核工具中的列表与详情 SQL。

## 本地备份与恢复

网页下载的是带清单、大小和 SHA-256 的原始分卷，本身不宣称已经加密。长期保存前使用 `pack` 生成默认加密容器，密码只允许通过 `SIMLETTRA_BACKUP_PASSWORD` 或 `--password-file` 提供。

```powershell
node tools/本地备份恢复.mjs validate --manifest 清单.json --parts 分卷 --manifest-sha256 清单摘要
node tools/本地备份恢复.mjs plan --manifest 清单.json --parts 分卷 --manifest-sha256 清单摘要 --output 恢复计划
node tools/本地备份恢复.mjs pack --manifest 清单.json --parts 分卷 --output 加密备份
node tools/本地备份恢复.mjs unpack --container 加密备份 --output 解密目录
node tools/本地备份恢复.mjs apply --manifest 清单.json --parts 分卷 --manifest-sha256 清单摘要 --output 恢复计划 --config wrangler.jsonc --database DB --storage-mode r2 --bucket simlettra-mail --confirm-empty-target RESTORE_EMPTY_TARGET
node tools/本地备份恢复.mjs finalize --manifest 清单.json --parts 分卷 --manifest-sha256 清单摘要 --output 恢复计划 --config wrangler.jsonc --database DB --storage-mode r2 --bucket simlettra-mail --restore-run-id 恢复运行编号
```

KV 模式使用 `--storage-mode kv --binding MAIL_OBJECTS_KV`。远程资源需要显式增加 `--remote`。首发只允许恢复到空白资源；D1、对象和搜索不能组成一个原子事务，任何阶段失败后都必须废弃目标资源并从空白目标重新执行。

## 旧系统数据迁移

迁移必须先固定只读来源快照，再使用独立目标完成演练。正式迁移只接受与来源快照、规则版本和目标迁移版本完全匹配的成功演练报告。旧仓库、旧 D1 以及旧 KV/R2 始终作为只读来源；迁移工具不会更新、删除或格式化旧资源。

```powershell
node tools/旧系统数据迁移.mjs snapshot --source-config 旧系统wrangler配置 --source-database SIMLETTRA_DB --source-storage-mode r2 --source-bucket 旧存储桶 --output 旧系统快照 --failure-report 快照失败报告.json
node tools/旧系统数据迁移.mjs validate --snapshot 旧系统快照 --failure-report 校验失败报告.json
node tools/旧系统数据迁移.mjs rehearse --snapshot 旧系统快照 --target-config 演练wrangler配置 --target-database DB --target-storage-mode r2 --target-bucket 演练存储桶 --report 迁移演练报告.json --failure-report 演练失败报告.json
node tools/旧系统数据迁移.mjs apply --snapshot 旧系统快照 --rehearsal-report 迁移演练报告.json --target-config wrangler.jsonc --target-database DB --target-storage-mode r2 --target-bucket simlettra-mail --confirm MIGRATE_LEGACY_COPY --failure-report 正式迁移失败报告.json
```

KV 来源使用 `--source-storage-mode kv --source-binding 旧KV绑定名`，KV 目标使用 `--target-storage-mode kv --target-binding MAIL_OBJECTS_KV`。旧来源和新目标的存储模式彼此独立，可以从 KV 迁移到 R2，也可以从 R2 迁移到 KV。

默认命令只操作 Wrangler 本地持久化资源。读取远程旧资源必须显式增加 `--source-remote`，写入远程演练或正式目标必须显式增加 `--target-remote`。正式执行前应先复制或冻结来源，并在隔离目标上完成一次演练；不能使用正式目标代替演练目标。
