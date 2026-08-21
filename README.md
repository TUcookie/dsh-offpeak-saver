# dsh-offpeak-saver · DeepSeek Harness 错峰省钱调度器

把非紧急任务排到 DeepSeek 空闲时段（官方 50% OFF）自动执行，并在每次完成后明确告诉你“这单省了多少钱”。任务持久化在本地 SQLite，Harness 重启后队列不丢。

> 已验证：`dsh` 0.1.0-rc.6 · Node 24 · pnpm 10/11

## 它解决什么

DeepSeek 自 **2026-08-17** 起实行峰谷定价：

| 项目 | 官方规则 |
| --- | --- |
| 高峰时段（北京时间） | 每日 09:00-12:00、14:00-18:00 |
| 空闲时段 | 其余时间，价格 = 高峰的一半 |
| V4 Flash（元/百万 tokens） | 高峰 输入 3.0 / 输出 9.0（缓存命中 0.1）；空闲 1.5 / 4.5（0.05） |
| V4 Pro（元/百万 tokens） | 高峰 输入 9.0 / 输出 27.0（缓存命中 0.3）；空闲 4.5 / 13.5（0.15） |

因此：**批量摘要、代码重构、RAG 预处理**这类不追求秒级响应的任务，应该“睡前提交、早上取结果”，全程半价。

## 功能

- **任务分流**：`offpeak_submit` 支持 `realtime` / `offpeak` / `background` 优先级；Prompt 中带 `#offpeak` / `#batch` 标签自动识别为错峰任务（`#realtime` 反之）。
- **持久化队列**：SQLite 本地存储（Node 内置 `node:sqlite`，零原生依赖），ACID 事务，Harness 重启后任务不丢失。
- **时间调度**：内置官方峰谷时间表（可热更新），每 30s 检查一次；进入空闲窗口瞬间唤醒队列，高峰前 10 分钟停止派发新任务，跨入高峰自动挂起（`paused`），下个空闲窗口恢复。
- **异步执行器**：信号量限流（默认并发 5），429/5xx 指数退避重试（默认 3 次，单层重试），单请求超时 30 分钟，全程不阻塞主界面。
- **会话内执行（B 方案）**：`execution_mode=session` 时，错峰任务在 Harness **原生会话**里唤醒 agent 执行——流式输出、中间步骤、可打断、可续聊，全程可见；执行后从会话事件提取文本与 token 用量完成计费。`execution_mode=direct` 则保持静默直连 API（批量场景）。
- **计费核算**：从 API `usage` 解析 tokens（含缓存命中），按**请求发起时刻**判定峰谷（与 DeepSeek 服务端口径一致），高峰按原价、空闲按 50%；结果写回本地 `results/<task_id>.md`。
- **账单面板**：`offpeak_report` 输出日/周/月累计：执行次数、实际花费、高峰原价、节省金额、等效免费 tokens。
- **通知事件**：`offpeak/task-completed`、`offpeak/task-failed` 等事件可被其他插件监听；超过 24 小时未执行的滞留任务启动时提醒。
- **热更新**：`offpeak_settings` 可在线修改峰谷时段、折扣率、并发数、价格表，写入 `config.json`，重启后依然生效。
- **Web 设置页面板（v0.2.0）**：Harness 设置里新增“错峰省钱”页，实时展示当前时段、下一空闲时段、今日/本周/本月节省、**正在执行的任务（开始时间、已执行时长、可直接取消）**、待执行任务、历史任务（含执行起止时间）与账单（日/周/月切换）。任务状态变化通过 SSE 实时推送，面板立即更新；另每 30 秒兜底轮询。

## 安装

### 方式一：打包安装

```sh
cd dsh-offpeak-saver
pnpm install
pnpm run build
pnpm pack
dsh plugin --profile web add ./dsh-offpeak-saver-0.2.0.tgz
dsh web --port 4099
```

### 方式二：本地开发热链接

```sh
dsh plugin --profile web add "link:$(pwd)"
```

安装后告诉 agent：“把这份 100 篇文档摘要的批处理任务排到错峰队列”，或直接让它调用 `offpeak_submit`。

## 配置

API Key 三种来源（优先级从高到低）：`cordis.yml` 插件配置 `api_key` → dsh `credentials` 服务（即 `~/.dsh/.credentials.yaml`，Web 设置页写入的密钥）→ 环境变量 `DEEPSEEK_API_KEY`。

| 配置键 | 默认值 | 说明 |
| --- | --- | --- |
| `api_key` | `''` | DeepSeek API Key（留空读环境变量） |
| `base_url` | `https://api.deepseek.com` | API 根地址 |
| `default_model` | `deepseek-v4-flash` | 默认模型 |
| `peak_hours` | `["09:00-12:00","14:00-18:00"]` | 高峰时段（北京时间） |
| `timezone_offset_hours` | `8` | 时区偏移 |
| `max_concurrency` | `3` | 同时 API 请求数上限（1–8，可在侧边栏滑块调整） |
| `retry_attempts` | `3` | 指数退避重试次数 |
| `backoff_base_ms` | `2000` | 退避基准延迟 |
| `request_timeout_ms` | `1800000` | 单请求超时（30 分钟） |
| `execution_mode` | `session` | `session` = 唤醒 Harness 会话原生执行；`direct` = 直接调 API 静默执行 |
| `stop_before_peak_minutes` | `10` | 高峰前停止派发新任务 |
| `check_interval_ms` | `30000` | 调度检查间隔 |
| `discount_rate` | `0.5` | 空闲折扣（官方 = 高峰一半） |
| `currency` | `CNY` | 金额展示币种 |
| `db_path` | 默认数据目录 | SQLite 路径 |
| `stale_hours` | `24` | 滞留任务提醒阈值 |
| `lease_ms` | `1800000` | running 任务认领租约，超时视为进程崩溃并重置重试 |
| `notify` | `true` | 发送完成/失败事件 |
| `pricing` | V4 Flash/Pro 官方价 | 各模型高峰价（元/百万 tokens） |

> `base_url` 只能在 cordis.yml / 安装配置里设置（必须 https），**不支持热更新**——防止 API Key 被改址外发。`currency: USD` 仅切换展示符号，不换算汇率，金额始终按人民币计价。

默认数据目录：`$DSH_HOME/data/offpeak-saver/`；dsh 运行时未设置 DSH_HOME 时，自动落到真实 Harness 主目录 `~/.dsh/data/offpeak-saver/`（本机即该路径），不存在时回退到 `~/.dsh-offpeak-saver/`。

## 工具

| 工具 | 用途 |
| --- | --- |
| `offpeak_submit` | 提交任务：`priority=realtime` 立即执行；`offpeak/background` 或 `#offpeak/#batch` 标签进入队列 |
| `offpeak_status` | 查询任务状态、费用、节省金额、结果预览 |
| `offpeak_report` | 日/周/月省钱账单 |
| `offpeak_cancel` | 取消 pending/paused 任务 |
| `offpeak_settings` | 查看/热更新配置 |

API Key 永不返回明文：`offpeak_settings` 只显示脱敏值（如 `****3456`）。

## Web 侧边栏面板

安装并重启 `dsh web` 后，打开 [http://127.0.0.1:3080](http://127.0.0.1:3080)，左侧栏底部会出现 **💰 错峰省钱** 按钮，点击即弹出面板；设置 → **错峰省钱** 仍保留作为兜底入口。面板内容：

- 顶部：当前时段徽章（高峰/空闲半价）与下一空闲时段。
- **提交任务**：面板顶部可直接填写 Prompt（可带 `#offpeak` 标签）、标题与优先级（实时/错峰/后台），点击加入队列；空 Prompt 会被拒绝，标题留空时自动取 Prompt 前 30 字。
- 汇总卡片：今日/本周/本月节省、错峰执行次数、等效免费 Tokens、待执行任务数。
- **正在执行**：运行中的任务带 LIVE 标记，显示开始时间与每秒刷新的已执行时长，可直接取消。
- 待执行任务：排队中的任务列表，可直接取消。
- 最近任务：最近 12 条（状态、Tokens、节省、执行起止时间、结果文件路径）。
- 账单：日/周/月切换，展示执行次数、实际花费、高峰原价、节省、等效免费 Tokens。
- 任务一启动/完成/失败，面板通过 SSE 立刻刷新；也可手动刷新；不足 1 分的金额显示 4 位小数，不会被抹成 ¥0.00。

示例对话：

> “用 offpeak_submit 提交：‘对 D:\docs 下 100 篇报告各写一段 200 字摘要，输出到 results/summary/’，标题叫批量摘要。”

完成后你会看到：`✅ 完成 | 💰 节省 ¥0.15 (50% OFF)`，并可通过 `offpeak_status` 查看结果文件路径。

## 本地演示（不启动 Harness）

```sh
export DEEPSEEK_API_KEY=sk-xxx
node scripts/demo.mjs submit "写 100 篇文档摘要" --realtime
node scripts/demo.mjs submit "#offpeak 周末批量重构代码注释"
node scripts/demo.mjs report week
```

## 测试与验证

```sh
pnpm typecheck
pnpm test          # 41 个单元测试：时间窗口、计费、队列、调度、工具
pnpm run build
pnpm pack
node scripts/integration-test.mjs   # 真实打包产物 + 真实 apply()/工具调用
bash scripts/dsh-smoke.sh           # 全新 DSH profile 安装 + web 启动
node scripts/verify-panel-render.mjs # 真实浏览器渲染设置页面板（需要系统 Chrome）
```

验收标准对照：

1. 标记“省钱”的任务只入队不立即调 API —— `offpeak_submit` 错峰路径 + 高峰窗口单测覆盖。
2. 空闲时段自动按序执行并返回结果 —— 调度器 tick + 队列 drain 测试覆盖。
3. 高峰时段不触发 API —— `shouldStopBeforePeak` 与执行器挂起逻辑测试覆盖。
4. 节省金额准确（误差 < 0.01 元）—— 计费引擎按官方价格表与 usage 计算。
5. 重启后任务不丢 —— SQLite 文件持久化测试覆盖。

## 会话内执行（B 方案）

默认 `execution_mode=session`：空闲时段到来时，调度器通过 `agents.resume/create` 唤醒（或新建）一个 Harness 会话，把任务作为用户消息发进去，agent 在原生会话里正常执行。因此：

- **过程可见**：流式思考与回复、工具调用全部出现在会话页面。
- **可打断**：任务执行期间可直接取消，中止在途回合。
- **可续聊**：结果留在会话里，直接追问“再展开一点”即可继续。
- **计费一致**：从会话事件提取 `assistant/message` 的 usage（含缓存命中），按请求发起时刻计算节省。

批量静默场景（如睡前丢 100 篇摘要）可用 `offpeak_settings` 把 `execution_mode` 切到 `direct`。

## 安全与可靠性（2026-08 审计修复）

- **计费时刻**：折扣按“请求发起时刻”判定（`billed_at`），跨峰谷边界不再产生假节省。
- **单层重试**：客户端只做超时/网络错误分类，重试统一由执行器执行（最坏 1+retry_attempts 次调用）；超时类错误不重试，避免“服务器已扣费但本地超时”的二次扣费。
- **本地错误不重试**：API 成功后的写库/写盘失败直接标记 failed，绝不再次调用 API。
- **原子认领**：`UPDATE ... WHERE status='pending'` 原子认领，多进程共享数据库也不会双重执行；`claimed_at` 租约超时后自动恢复。
- **优雅关闭**：`stop()` 先中止在途请求、等待收尾，再关数据库；关闭后禁止一切重试。
- **密钥保护**：`api_key` 输出脱敏；`base_url` 移出热更新白名单且强制 https；`config.json` 只合并白名单键，不能注入 `api_key`；`pricing` 逐项校验为非负有限数。
- **时段校验**：非法小时/分钟（如 `99:00`）直接拒绝，杜绝“全天误判为空闲”。
- **usage 校验**：缺失/非法 usage 与空内容按失败处理，不再静默记 ¥0。

## 架构

```text
src/
├── index.ts      # dsh 插件入口：Config schema、apply()、版本守卫、事件转发
├── core.ts       # 核心门面：组合数据库/执行器/调度循环，可独立用于 CLI
├── config.ts     # 默认配置 + config.json 热更新覆盖
├── db.ts         # SQLite：tasks / billing_logs / config 三表
├── time.ts       # 峰谷窗口判断（UTC+8，支持跨零点）
├── billing.ts    # 计费核算：实际/基准/节省/等效免费 tokens
├── client.ts     # DeepSeek API 客户端：超时、重试、usage 解析
├── executor.ts   # 异步执行器：信号量、退避、跨峰挂起
├── reports.ts    # 日/周/月账单
├── tools.ts      # 5 个 dsh 工具
└── version.ts    # peer 版本守卫
```

## 故障排查

- **依赖零原生模块**：存储层使用 Node 内置 `node:sqlite`（Node 22.13+ 免 flag，DSH 要求 22.19+），安装到任何 profile 都不需要编译原生模块。
- **提示 dsh-tools 版本不兼容**：升级 Harness 到 0.1.0-rc.6 或更新后重装插件；不要用 `--legacy-peer-deps` 强压，运行守卫会拒绝加载。
- **任务一直 pending**：检查当前是否处于高峰时段（`offpeak_status` 可看），以及 `peak_hours` 配置是否符合预期。
- **价格与官方不一致**：DeepSeek 调价后，用 `offpeak_settings` 更新 `pricing` 与 `peak_hours`，无需重启。

## 路线图

- **v1.1** 多模型混合调度：非高峰用 V4 Pro，高峰自动降级本地小模型。
- **v1.2** 预测式预热：窗口开启前预建连接。
- **v1.3** 开放 API：其他插件可调用本调度器做成本优化。

## License

MIT © 2026 dsh-offpeak-saver contributors
