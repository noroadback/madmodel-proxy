# 接入 dsh（首次配置指南）

从零到 dsh 能用上 madmodel，大约 5 分钟，已在 Windows 11 + Node.js 24 + dsh 上实测。其他 OpenAI 兼容客户端的配置方式相同。

前置三样。Windows、macOS 或 Linux；Node.js 18.14 以上（终端跑 `node -v` 确认，版本太低程序会直接报错）；一个清华统一认证账号。本工具零第三方依赖，clone 之后不用 `npm install`。

## 第 1 步：保存凭据

```bat
node refresh-token.js login
```

按提示输学号和密码。密码输入不回显。

第一次登录大概率会遇到二次认证（新设备验证）。终端会列出可用的验证方式（微信 / 手机短信 / TOTP），输序号选一个，收到验证码后输六位数字。验证通过后，这台设备会被登记为学校侧的可信设备，之后的自动续期不再需要二次认证。这一步只需要做一次。

成功的标志是形如 `✅ token 已获取,有效期至 …` 的一行。

此时状态目录下生成了两个文件（Windows 在 `%USERPROFILE%\.dsh-madmodel\`，macOS / Linux 在 `~/.dsh-madmodel/`）。`creds.json` 存学号、密码和设备指纹，`token.json` 存 madmodel API token，都是静态加密：Windows 用 DPAPI，macOS 存登录钥匙串，Linux 用机器绑定加密（文件离开这台机器即不可解）。密码只以两种形态存在，本机密文，以及发往 `id.tsinghua.edu.cn` 的 SM2 加密报文（学校登录协议本身的要求），不经任何第三方，不写日志。

## 第 2 步：启动

Windows 双击 **`start.cmd`**（首次启动会问是否创建桌面快捷方式，之后从桌面启动即可），macOS / Linux 运行 `npm start`。它以单窗口拉起续期守护和本地端点，日志用 `[watch]` 和 `[代理]` 前缀区分，Ctrl+C 或关窗全部停止；代理在运行时再次运行 start.cmd 会显示状态，不会启动第二个实例。

启动成功的输出。

```
[watch] madmodel token 自动续期守护进程已启动(PID 12345)
[代理] madmodel 本地端点已启动: http://127.0.0.1:8080/v1
[代理] 模型: DeepSeek-V4-Flash
[代理] 本地无鉴权(客户端 API key 填任意值);安全边界为本机回环 + Host 白名单
[代理] token 文件: %USERPROFILE%\.dsh-madmodel\token.json(热加载,续期免重启)
[代理] 当前 token 剩余 272 分钟
```

macOS / Linux 上 `token 文件` 一行显示为 `~/.dsh-madmodel/token.json`，其余相同。

## 第 3 步：配置 dsh

在 dsh 的供应商（Provider）配置里新建或编辑一条 OpenAI 兼容配置。界面若让你选协议类型，选 Chat Completions。

| 配置项 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:8080/v1` |
| API Key | 任意值（本地无鉴权，字段仅需满足界面非空校验） |
| 模型名 | `DeepSeek-V4-Flash` |

## 第 4 步：验证

在 dsh 里发一条消息，收到回复即完成。也可以先跑 `curl http://127.0.0.1:8080/v1/models` 确认代理存活，返回模型列表即正常，此时问题只会出在 dsh 的 Base URL 或模型名配置上。

## 日常

- 开机后启动（Windows 用桌面快捷方式或 start.cmd，macOS / Linux 用 `npm start`），窗口保持开启
- token 到期前 30 分钟自动续期，代理热加载新 token
- 代理在运行时重复运行 start.cmd 会显示状态，不会启动第二个实例
- 改了统一认证密码的话，守护连续 3 次登录失败会自动退出并提示，重跑一遍第 1 步（`login`）即可，其他配置不受影响
- 找不到项目文件夹时，右键桌面快捷方式选"打开文件所在位置"；仓库丢失可重新 clone，状态目录（Windows `%USERPROFILE%\.dsh-madmodel\`，macOS / Linux `~/.dsh-madmodel/`）与仓库分离，登录状态不丢失

## 故障排查

| 现象 | 处理 |
|---|---|
| 401"token 已过期" | 续期守护没在跑。看 start.cmd 窗口的 `[watch]` 日志是否报错或停了，死了就重开 start.cmd |
| 503 | 本地无 token。没做过第 1 步，或 `[watch]` 日志有报错 |
| 429 | 上游繁忙或过载保护。稍等重试；持续出现看代理日志的 `overload:` 或 `upstream-err` 条目 |
| 5xx 且提示上游拒绝 | madmodel 服务端的问题，与本工具无关，稍后再试 |

要换端口用 `PROXY_PORT` 环境变量。接入其他 OpenAI 兼容客户端，配置方式与 dsh 完全一致。
