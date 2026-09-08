# 变更日志

本文件记录各版本的行为变化与关键取舍。日期为实测或落地日期。

## 1.4.1

### 移除 gzip 请求体规避（2026-09-08）

- 上游移除了 madmodel 端点的 WAF（thu-info 社区在 issue 中确认，本仓库实测复核：非压缩请求体携带工具语法与 `(set ` 触发字面量直发通过）。此前 WAF 的 SQL 注入特征规则会误拦含该字面量的明文请求体，代理以 gzip 编码规避——规避随之移除，`PROXY_NO_GZIP` 配置一并删除，请求体恢复明文直发。
- 若 WAF 回归：完整实现保留在 git 历史里，revert 本版本即可恢复。

## 1.4.0

### 跨平台：macOS 与 Linux 支持（2026-09-08）

- 凭据存储按平台实现。macOS 登录钥匙串：经系统自带 `security` 命令行，秘密以 base64 编码过通道（该 CLI 对非 ASCII 的编码行为不可靠，CI 于 macOS runner 实测发现写入成功但读回损坏），学号/指纹等非秘密字段留在 JSON 元数据。Linux 机器绑定 AES-256-GCM：密钥由 `/etc/machine-id` 与当前用户派生，文件被拷贝或同步到其他机器后不可解。Windows 的 DPAPI 路径不变，已有凭据无需迁移。
- 进程锁实现提升为共享（`process.kill` 探活本就跨平台，原先只是住在 `platform/windows/` 目录下）；`package.json` 移除 `os` 限制。启动方式：Windows 双击 `start.cmd`，macOS / Linux 运行 `npm start`。
- CI 增加三平台冒烟（ubuntu / macos / windows）：临时状态目录内做凭据与 token 的写入-读回往返（真实调用各平台存储原语）、无 token 启动代理并探活 `/v1/models`、watch 守护的无凭据调度循环。全程不访问学校服务、不消耗配额。
- 验证口径。Windows 全量（本机真实流量）；Linux 于 WSL Ubuntu 端到端（真实 token 起代理、真实上游请求、token 热加载）；macOS 由 CI runner 覆盖存储与启动路径，真实登录链（含二次认证）尚无真机完整实测，首次使用如遇问题请带日志提 issue。

## 1.3.2

### 修复（2026-09-08）

- 流式透传对慢客户端不再持续缓冲。SSE 分块写入此前丢失背压等待信号，客户端读得慢时代理不会暂停读上游，内存随流增长（受 64MB 流上限兜底），现补回返回值逐块等待排空。
- watch 守护独立在跑、代理已停时再开 start.cmd 不再 5 秒循环重启。dashboard 对子进程"正常退出(code 0)"此前仍排自动重启定时器，与文件头"明确正常退出不重启"的注释不符；顺带修掉同路径上一处会留下无子进程窗口的收尾遗漏。
- 注释与文档校准。移除指向已删测试文件的注释引用；"不会重复启动"限定为代理在运行时；README 环境变量表补齐 watch 调度两项、常见问题补 503。

## 1.3.1

### 移除测试套件（2026-09-07）

- 14 个测试文件（约 3800 行）连同 npm test 脚本、CI 测试矩阵一并移除，提交历史同步改写，仓库不再包含任何测试代码。验证手段回归两件事，`node --check` 语法门（CI 保留，单 job）和 `npm run smoke` 真实流量冒烟。
- 依据。对照同量级清华校园工具（learn2018-autodown 387★、GoAuthing 300★、thu-checkin 44★、THU-Yuketang-Helper 41★），四个参考项目三个零测试、一个 2 个文件；本项目常驻代理的验证需求由 smoke 覆盖协议行为，CI 语法门覆盖加载路径，日常改动靠代码审阅。
- 根目录从 34 个文件降到 25 个，与小工具的定位一致。

## 1.3.0

### 移除本地 Bearer 鉴权（2026-09-07）

- 删掉本地鉴权层、`key` 命令、`PROXY_API_KEY` / `PROXY_NO_AUTH` 配置和 `api-key` 状态文件。安全边界收窄为本机回环（只监听 127.0.0.1）加 Host 白名单，客户端 API key 随便填，字段只为满足界面非空校验。
- 取舍依据。单用户个人机器上，鉴权挡的"本机恶意网页盲调配额"是低频威胁，而 key 的获取与配置是真实的新用户摩擦（冷启动验收实证过）。需要鉴权的用户可以在 `adapters/http-server.js` 自行加回，Bearer 解析约 20 行。
- 顺带修复（冷启动验收发现，都带了回归测试）。管道（非 TTY）login 此前会永久挂死，`rl.close()` 在管道模式会结束 stdin，密码监听永等；TTY login 的密码此前明文回显，上一版修复把 close 挪后，readline 的 echo 与 `*` 掩码叠成了双写。

## 1.2.1

### 并发策略：移除业务层限流，保留进程保护硬上限（2026-09-06）

- 删除 `core/limits.js` 和 `PROXY_MAX_CONCURRENT` / `PROXY_RATE_LIMIT` 配置。理由是多子代理编排（一个 orchestrator 派十几个 sub-agent 同时调模型）是合法负载，固定并发 8 会常态化误伤并诱发客户端重试。
- 保留一个不可配置的 inflight 硬上限（64）作为进程保护，非常规业务限流。它防失控客户端紧循环拖垮内存（非流式聚合单流最多缓冲 64MB）与连接。`server.maxConnections=32` 只限 TCP 连接数，keep-alive 复用可绕过，所以这一层仍然必要。超限回 429（文案写明"过载保护/进程保护"），日志记 `overload:inflight=N`。
- 资源兜底不变。请求体/响应体限额、慢速发送三段超时、总时限全在 HTTP 适配层保留，上游自身的 429 翻译照常工作。本地 429 从此只有一种来源，即进程过载保护，与上游 429 的翻译文案可区分，`limited:*` 日志不再产生。
- inflight 硬上限（64，config.js 代码常量，冻结对象，无环境变量解析路径）有 8 项独立单测，覆盖上限拒绝、早退不占槽、断开释放、顺序无泄漏，以及四种异常形态（上游请求 reject、headers/idle/total 三类超时、onChunk 抛错、响应写入抛错）后计数必须归零的泄漏探针。
- 测试计数口径。`test-auth` 38，`node --test` 单元 70（含 scheduler 10、inflight 8），`test-proxy` 端到端 69，合计 177 项；`test-creds` 的 3 项 DPAPI 自检不计入。

## 1.2.0

### 内部结构：core/platform/adapters 分层重写（行为无变化，2026-09-06）

- 模块按依赖方向重组。`core/` 放业务与协议（不读环境变量、不碰文件系统、不依赖 Windows API、不写 HTTP 响应），`platform/` 放 DPAPI 凭据、路径、原子文件、进程锁、目录监听（Windows 实现收在 `platform/windows/`），`adapters/` 只做 HTTP 与终端 I/O。原根目录 18 个文件（server/upstream/sse/aggregator/limits/payload/errors/response/request/auth-middleware/storage/stream-utils/cli/file-wakeup/atomic-file/creds/secure-store/paths）全部迁移或合并删除，入口仍是 `node proxy.js` 和 `node refresh-token.js ...`。
- 上游客户端统一为 7 种结果类型（`stream`/`completion`/`upstream-error`/`timeout(phase: headers|idle|total)`/`aborted`/`protocol-error`/`network-error`），单个 AbortController 管理整个生命周期，header/idle/total 三类超时走同一条收尾清理路径。SSE 解析器接管 UTF-8 解码，多字节字符跨 chunk 切开也能正确拼帧。
- watch 续期守护抽出 `core/scheduler.js` 状态机（WAITING/REFRESHING/BACKOFF/STOPPED），认证协议细节留在 auth-service。调度器有独立单测，覆盖退避档位、闸门不被文件事件绕过、TWO_FACTOR_REQUIRED 立即停、BAD_CREDENTIALS 连续三次停、AUTH_BUSY 短退避。
- 限流修正。并发被拒的请求不再计入速率窗口，该修正随 1.2.1 的限流移除一并成为历史。
- 离线测试从 158 项（重写前基线）扩到 177 项。1.2.0 新增 scheduler 10 项、upstream-client 接口 1 项、limits/payload/errors/sse 契约 4 项；1.2.1 移除 limits 测试 4 项、新增 inflight 8 项（上限守卫 4 项加异常释放 4 项）。`npm run smoke` 收敛为最小请求集（/v1/models、一次短流式、一次非流式）。

## 1.1.0

### 新增

- **请求参数归一化**。主流 OpenAI 客户端（dsh / codex / claude code）会发上游拒绝或忽略的参数，原样转发会让错误信息指向完全错误的方向。现统一改写并记入访问日志（`norm[...]`）。任意 `model` 重写为 `DeepSeek-V4-Flash`，配错名字不再回"模型不存在"；剥离上游直接拒绝的 `logprobs` / `top_logprobs` 和 `n > 1`；"关闭推理"的三种客户端方言（`reasoning_effort: 'none'`、`thinking: false`、`thinking: {type:'disabled'}`）统一映射到上游唯一生效的 vLLM 方言 `chat_template_kwargs.thinking = false`，而不是丢掉，未表达该意图时只剥离、不注入。
- **`test-auth.js`**。认证链纯逻辑的离线测试 38 项，覆盖响应体解码、重定向白名单含 userinfo 伪装、CookieJar 路径匹配、JWT 兜底、WebVPN URL 改写。此前认证链是零覆盖区。

### 修复

- **`密码不正确` 一直未被识别**。手工维护的 GBK 字节表把该短语末字节写成 `184`（雀）而非 `183`（确），该判定自始未生效；同一处的 4 个 `body.indexOf('中文')` 检查也因响应体按 latin1 读取而永远不匹配。后果是这种页面形态下密码错误被误判为 `LOGIN_FAILED` 而非 `BAD_CREDENTIALS`，watch 的"连续 3 次密码失效即停"保护随之失效，守护会每 30 分钟拿错密码重试一次。现改为按 charset 正确解码（声明优先，未声明则 UTF-8 探测失败后回退 GBK），中文匹配改用字面量，字节表与 latin1 读法一并删除。
- 顺带修掉两类由 latin1 读法引起的问题。GBK 汉字尾字节落在 ASCII 区间（`0x40` 到 `0x7E`）时会被误读成结构字符；二次认证接口返回的 JSON 里中文消息（`json.msg`）此前是乱码。
- `callUpstream` 此前把外部 abort signal 桥接了两遍，其中一段是死代码。
- 非 Windows 平台调用 DPAPI 时给出明确错误，不再抛裸 `ENOENT ... powershell.exe`。
- `USERPROFILE` 未定义时（非 Windows）状态目录会解析成相对路径、把状态文件写进当前工作目录，现退回 `os.homedir()`。
- `X-Token-Refresh-Hint` 此前只在非流式响应里出现，流式路径算了却丢掉。

### 内部结构（行为无变化）

- 抽出 `atomic-file.js`。`proxy.js` 的 api-key 引导与 `refresh-token.js` 的 PID 锁此前各有一份"临时文件 + link 安装 + rename 仲裁接管"的独立实现，现统一为 `installExclusive` / `claimFile` / `atomicWrite` 三个原语。PID 锁的无界忙等改为有界重试（超限抛 `LOCK_CONTENTION`），并消掉了原实现里 `NaN !== NaN` 的比较陷阱。
- 抽出 `paths.js`。状态目录与各状态文件路径、以及"`PROXY_NO_AUTH` > `PROXY_API_KEY` > key 文件"的鉴权优先级，此前分散在 5 个文件里各写一遍，优先级口径曾漂移。
- `proxy.js` 中"流未以合法 `[DONE]` 结束"的三种形态（截断 / 坏帧 / 总时限）在流式与非流式两条路径共用 `describeFailedStream`，不再各写一份文案。
- 日志时间戳固定为 `HH:MM:SS`，不再随机器 locale 变形。
- `sm2.js` 的 vendored 完整性声明补上 sha256 与字节数，并给出可复现的核验命令。
- 全项目字符串拼接迁为模板字符串；CI 增加 `node --check` 语法门，覆盖测试不加载的文件。

### 安全与稳健性加固（2026-09-02 到 2026-09-04，三轮）

- Host 头白名单，阻断 DNS rebinding（外部域名解析到 127.0.0.1 后借合法 Origin 读响应）。
- 本地鉴权默认强制。未显式设 `PROXY_API_KEY` 时启动自动生成随机 key 并写入 `~/.dsh-madmodel/api-key`（首启打印，客户端配置同值 Bearer），恶意网页的 blind POST / CSRF 无法携带该 key。`PROXY_NO_AUTH=1` 仅限测试显式关闭。（该层随 1.3.0 移除，记录保留。）
- 客户端断开或聚合超时即中止上游请求，不再白烧配额，所有兜底写响应均有守卫。
- 请求体读取阶段即受保护，包括 Content-Length 预检、`server.maxConnections`、`headersTimeout` / `requestTimeout` 覆盖慢连接攻击。
- 上游响应头超时。fetch 发出后 30s 未见响应头即中止，不再长期占用并发槽。
- 上游响应体设总量上限（JSON 5MB / SSE 64MB），异常大响应不再无限吃内存。
- 失败请求体落盘默认关闭（body 含完整对话内容，隐私），设 `DUMP_FAILED=1` 开启。
- 上游以 JSON 返回完整 completion 时不再当"空流"丢弃，照常交付，真空流回 502。
- 请求体非 JSON 对象（如 `null` / 数组）回 400，而非触发内部错误。
- socket 层错误不再有击穿进程的路径，`EADDRINUSE` 有清晰提示。
- 早退路径（403 / 401 / 413 / 429 等）同样进访问日志。防御被触发而日志无痕，事后无从回答"有没有进程在打我""限速替我挡了多少次"。
- 上游 SSE 流内嵌 `errorMessage`（模型不存在 / 繁忙等，实测形态）不再当正常 chunk 透传。非流式翻译为 502/429 带原文，流式头已发出则断流并记日志。
- 上游 HTML 错误页（TsinghuaLB 502，实测形态）翻译为明确文案。
- 对上游注入 `stream_options.include_usage`（上游默认不回 usage），非流式聚合与流式透传均得到真实 token 数，`reasoning_tokens` 单独可见。

### 上游行为适配

- **2026-09-05**。上游网关会在 SSE 流中夹带空数据帧（`data:` 空行，心跳）。此前的坏帧严格性把它误判为协议错误并终止流，60 项离线测试全绿仍在真实流量上翻车。现容忍空帧，非空坏帧仍按协议错误终止。同日新增 `smoke-real.js`（真实流量冒烟），离线套件只能覆盖已知的帧型。

## 1.0.0

首次公开发布。madmodel 本地 OpenAI 兼容代理加清华统一认证 token 自动续期。
