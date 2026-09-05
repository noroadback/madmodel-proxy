# 变更日志

本文件记录面向使用者的行为变化。日期为实测/落地日期。

## 1.1.0

### 新增

- **请求参数归一化**:主流 OpenAI 客户端(dsh / codex / claude code)会发上游拒绝或忽略的参数,原样转发会让错误信息指向完全错误的方向。现统一改写并记入访问日志(`norm[...]`):
  - 任意 `model` 重写为 `DeepSeek-V4-Flash`(单模型代理,配错名字不再回"模型不存在");
  - 剥离上游直接拒绝的 `logprobs` / `top_logprobs`,以及 `n > 1`;
  - "关闭推理"的三种客户端方言(`reasoning_effort: 'none'`、`thinking: false`、`thinking: {type:'disabled'}`)统一映射到上游唯一生效的 vLLM 方言 `chat_template_kwargs.thinking = false`,而不是丢掉;未表达该意图时只剥离、不注入。
- **`test-auth.js`**:认证链纯逻辑的离线测试 38 项(响应体解码、重定向白名单含 userinfo 伪装、CookieJar 路径匹配、JWT 兜底、WebVPN URL 改写)。此前认证链是零覆盖区。

### 修复

- **`密码不正确` 一直未被识别**:手工维护的 GBK 字节表把该短语末字节写成 `184`(雀)而非 `183`(确),该判定自始未生效;同一处的 4 个 `body.indexOf('中文')` 检查也因响应体按 latin1 读取而永远不匹配。后果是这种页面形态下密码错误被误判为 `LOGIN_FAILED` 而非 `BAD_CREDENTIALS`,watch 的"连续 3 次密码失效即停"保护随之失效,守护会每 30 分钟拿错密码重试一次。现改为按 charset 正确解码(声明优先,未声明则 UTF-8 探测失败后回退 GBK),中文匹配改用字面量,字节表与 latin1 读法一并删除。
- 顺带修掉两类由 latin1 读法引起的问题:GBK 汉字尾字节落在 ASCII 区间(`0x40`-`0x7E`)时会被误读成结构字符;二次认证接口返回的 JSON 里中文消息(`json.msg`)此前是乱码。
- `callUpstream` 此前把外部 abort signal 桥接了两遍,其中一段是死代码。
- 非 Windows 平台调用 DPAPI 时给出明确错误,不再抛裸 `ENOENT ... powershell.exe`。
- `USERPROFILE` 未定义时(非 Windows)状态目录会解析成相对路径、把状态文件写进当前工作目录;现退回 `os.homedir()`。
- `X-Token-Refresh-Hint` 此前只在非流式响应里出现,流式路径算了却丢掉。

### 内部结构(行为无变化)

- 抽出 `atomic-file.js`:`proxy.js` 的 api-key 引导与 `refresh-token.js` 的 PID 锁此前各有一份"临时文件 + link 安装 + rename 仲裁接管"的独立实现,现统一为 `installExclusive` / `claimFile` / `atomicWrite` 三个原语。PID 锁的无界忙等改为有界重试(超限抛 `LOCK_CONTENTION`),并消除了原实现里 `NaN !== NaN` 的比较陷阱。
- 抽出 `paths.js`:状态目录与各状态文件路径、以及"`PROXY_NO_AUTH` > `PROXY_API_KEY` > key 文件"的鉴权优先级,此前分散在 5 个文件里各写一遍(优先级口径曾漂移)。
- `proxy.js` 中"流未以合法 `[DONE]` 结束"的三种形态(截断 / 坏帧 / 总时限)在流式与非流式两条路径共用 `describeFailedStream`,不再各写一份文案。
- 日志时间戳固定为 `HH:MM:SS`,不再随机器 locale 变形。
- `sm2.js` 的 vendored 完整性声明补上 sha256 与字节数,并给出可复现的核验命令。
- 全项目字符串拼接迁为模板字符串;CI 增加 `node --check` 语法门(覆盖测试不加载的文件)。

### 安全与稳健性加固(2026-09-02 ~ 2026-09-04,三轮)

- Host 头白名单:阻断 DNS rebinding(外部域名解析到 127.0.0.1 后借合法 Origin 读响应);
- 本地鉴权默认强制:未显式设 `PROXY_API_KEY` 时启动自动生成随机 key 并写入 `~/.dsh-madmodel/api-key`(首启打印,客户端配置同值 Bearer)。恶意网页的 blind POST / CSRF 无法携带该 key,配额不再裸奔。`PROXY_NO_AUTH=1` 仅限测试显式关闭;
- 客户端断开 / 聚合超时即中止上游请求(不再白烧配额),所有兜底写响应均有守卫;
- 请求体读取阶段即受保护:Content-Length 预检、`server.maxConnections`、`headersTimeout` / `requestTimeout` 覆盖慢连接攻击;
- 上游响应头超时:fetch 发出后 30s 未见响应头即中止,不再长期占用并发槽;
- 上游响应体设总量上限(JSON 5MB / SSE 64MB),异常大响应不再无限吃内存;
- 失败请求体落盘默认关闭(body 含完整对话内容,隐私):设 `DUMP_FAILED=1` 开启;
- 上游以 JSON 返回完整 completion 时不再当"空流"丢弃,照常交付;真空流回 502;
- 请求体非 JSON 对象(如 `null` / 数组)回 400 而非触发内部错误;
- socket 层错误不再有击穿进程的路径;`EADDRINUSE` 有清晰提示;
- 早退路径(403 / 401 / 413 / 429 等)同样进访问日志:防御被触发而日志无痕,事后无从回答"有没有进程在打我""限速替我挡了多少次";
- 上游 SSE 流内嵌 `errorMessage`(模型不存在 / 繁忙等,实测形态)不再当正常 chunk 透传:非流式翻译为 502/429 带原文,流式头已发出则断流并记日志;
- 上游 HTML 错误页(TsinghuaLB 502,实测形态)翻译为明确文案;
- 对上游注入 `stream_options.include_usage`(上游默认不回 usage):非流式聚合与流式透传均得到真实 token 数,`reasoning_tokens` 单独可见。

### 上游行为适配

- **2026-09-05**:上游网关会在 SSE 流中夹带空数据帧(`data:` 空行,心跳)。此前的坏帧严格性把它误判为协议错误并终止流——60 项离线测试全绿仍在真实流量上翻车。现容忍空帧,非空坏帧仍按协议错误终止。同日新增 `smoke-real.js`(真实流量冒烟),离线套件只能覆盖*已知*帧型。

## 1.0.0

首次公开发布:madmodel 本地 OpenAI 兼容代理 + 清华统一认证 token 自动续期。
