# 接入 dsh（首次配置指南）

从零到 dsh 能用上 madmodel，大约 5 分钟。流程已在 Windows 11 + Node.js 24 + dsh 上实测走通；其他 OpenAI 兼容客户端的配置方式与 dsh 一致，未逐一验证，欢迎在 issue 里附上你的结果。

前置三样。Windows 10/11（凭据存储用 DPAPI，暂不支持 macOS/Linux）；Node.js 18.14 以上（终端跑 `node -v` 确认，版本太低程序会直接报错）；一个清华统一认证账号。本工具零第三方依赖，clone 之后不用 `npm install`。

## 第 1 步：保存凭据

```bat
node refresh-token.js login
```

按提示输学号和密码。密码输入不回显。

第一次登录大概率会遇到二次认证（新设备验证）。终端会列出可用的验证方式（微信 / 手机短信 / TOTP），输序号选一个，收到验证码后输六位数字。验证通过后，这台设备会被登记为学校侧的可信设备，之后的自动续期不再需要二次认证。这一步只需要做一次，中间输错验证码重试就行。

成功的标志是形如 `✅ token 已获取,有效期至 …` 的一行。

此时 `%USERPROFILE%\.dsh-madmodel\` 下生成了两个文件。`creds.json` 存学号、密码和设备指纹，`token.json` 存 madmodel API token，都是 DPAPI 加密，只有当前 Windows 账户解得开。密码只以两种形态存在，本机 DPAPI 密文，以及发往 `id.tsinghua.edu.cn` 的 SM2 加密报文（学校登录协议本身的要求），不经任何第三方，不写日志。

## 第 2 步：启动

双击 **`start.cmd`**（在 PowerShell 里运行要写 `.\start.cmd`，CMD 里直接 `start.cmd` 即可）。首次启动会问你要不要在桌面创建快捷方式，按 Y 之后开机从桌面双击启动，省去找文件夹。然后它以单窗口拉起续期守护和代理，日志用 `[watch]` 和 `[代理]` 前缀区分，Ctrl+C 或关窗全部停止；重复双击无害，已有实例在跑就直接退出。

看到这样的输出就是成功了。

```
[watch] madmodel token 自动续期守护进程已启动(PID 12345)
[代理] madmodel 本地端点已启动: http://127.0.0.1:8080/v1
[代理] 模型: DeepSeek-V4-Flash
[代理] 本地无鉴权(客户端 API key 随便填);安全边界为本机回环 + Host 白名单
[代理] 当前 token 剩余 272 分钟
```

## 第 3 步：配置 dsh

在 dsh 的供应商（Provider）配置里新建或编辑一条 OpenAI 兼容配置。界面若让你选协议类型，选 **Chat / Chat Completions**（不要选 Anthropic Messages、Responses、Gemini Native，那是别家的协议）。

| 配置项 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:8080/v1` |
| API Key | 随便填（如 `none`），本地无鉴权，字段只为满足界面非空校验 |
| 模型名 | `DeepSeek-V4-Flash` |

## 第 4 步：验证

在 dsh 里随便发一条消息，收到回复就全部完成。想先单独确认代理活着，可以跑一下 `curl http://127.0.0.1:8080/v1/models`，返回模型列表即正常，此时问题只会出在 dsh 的 Base URL 或模型名配置上。

## 日常

- 开机后从桌面快捷方式（或 start.cmd）双击启动，窗口最小化挂着即可
- token 全自动。到期前 30 分钟自动续期，代理热加载新 token，你什么都不用做，可以忘了这回事
- 重复双击无害。单实例锁自动探活，旧守护死了新守护接管
- 改了统一认证密码的话，守护连续 3 次登录失败会自动退出并提示，重跑一遍第 1 步（`login`）即可，其他配置不受影响
- 找不到项目文件夹时，右键桌面快捷方式选"打开文件所在位置"；或者仓库丢了直接重新 clone（状态目录在 `%USERPROFILE%\.dsh-madmodel\`，与仓库分离，重 clone 不丢登录状态）

## 出问题时

| 现象 | 处理 |
|---|---|
| 401"token 已过期" | 续期守护没在跑。看 start.cmd 窗口的 `[watch]` 日志是否报错或停了，死了就重开 start.cmd |
| 503 | 本地无 token。没做过第 1 步，或 `[watch]` 日志有报错 |
| 429 | 上游繁忙或过载保护。稍等重试；持续出现看代理日志的 `overload:` 或 `upstream-err` 条目 |
| 5xx 且提示上游拒绝 | madmodel 服务端的问题，与本工具无关，稍后再试 |

要换端口用 `PROXY_PORT` 环境变量。接入其他 OpenAI 兼容客户端，配置方式与 dsh 完全一致。
