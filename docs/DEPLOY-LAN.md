# 局域网访问

在一台电脑上运行代理，其他设备通过它调用学校服务。服务端需要 Node.js 18.14 以上和清华大学统一认证账号，推荐 Node.js 24。客户端只需要代理地址和 API Key，无需复制学校密码或 token。

默认仍只允许本机访问。下面的设置会开放局域网连接，密钥和对话通过 HTTP 传输，请仅在可信网络使用，并在防火墙中限制来源。跨不可信网络访问时使用 HTTPS 反向代理或 SSH 隧道。每个密钥具有相同权限，共享服务端学校账户的配额和并发限制。

## 启动代理

在服务端按 [快速开始](../README.md#快速开始) 下载项目并运行 `npm run login`。在项目目录设置监听地址和密钥后启动。

PowerShell

```powershell
$env:PROXY_BIND_HOST = "0.0.0.0"
$env:PROXY_API_KEYS = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
$env:PROXY_API_KEYS
npm start
```

macOS / Linux

```sh
export PROXY_BIND_HOST=0.0.0.0
export PROXY_API_KEYS="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
printf '%s\n' "$PROXY_API_KEYS"
npm start
```

把生成的密钥填入客户端，不要公开终端截图。重新执行生成命令会更换密钥，客户端也要同步更新。仅需保护本机访问时，把监听地址改为 `127.0.0.1`。

首次启动按提示选择校园网或 WebVPN。也可运行 `npm start -- campus` 或 `npm start -- offcampus`。显式设置的 `PROXY_UPSTREAM` 优先于网络选项；要切回内置网络选择，先清除该变量。

`0.0.0.0` 监听所有 IPv4 网卡，也可填写服务端的某个网卡 IP。IPv6 可用 `::`，客户端 URL 中的 IPv6 地址需带方括号。非回环监听未配置有效密钥时，代理会拒绝启动。

## 连接客户端

| 配置项 | 填写方式 |
|---|---|
| API 类型 | OpenAI Chat Completions |
| Base URL | `http://服务端局域网IP:8080/v1`，端口按实际配置填写 |
| API Key | 服务端刚生成的密钥 |
| 模型 | 获取列表后选择，或参考 [模型配置](../README.md#模型配置) 手填 ID |

请求使用 `Authorization: Bearer <key>`，也支持 `x-api-key`。同时存在时以 Authorization 为准，格式错误不会回退。密钥放在 URL 查询参数中无效。浏览器地址栏不能附带密钥，开启鉴权后请在客户端获取模型列表；网页客户端需要同源代理，本服务不开放 CORS。

`PROXY_API_KEYS` 可填写多个逗号分隔的密钥，便于分发和轮换。更改后重启服务。它们只控制代理访问，不会修改学校登录凭据。

`GET /healthz` 无需密钥，只返回 `{"status":"ok","proxy":"madmodel"}`，表示代理进程可以响应，不代表已登录或上游可用。运行 `npm run status` 时使用与服务端相同的监听地址、端口和状态目录设置。

## Linux 后台运行

使用 systemd 用户服务管理代理和续期进程。下面假设项目在 `~/madmodel-proxy`，登录、服务运行和状态查询使用同一系统账户。先在前台确认能够使用，再按 Ctrl+C 停止。

在刚才设置密钥的终端保存配置。文件包含代理密钥，仅当前账户可读。

```sh
mkdir -p ~/.config/madmodel-proxy ~/.config/systemd/user
umask 077
test -n "$PROXY_API_KEYS" && printf 'PROXY_BIND_HOST=%s\nPROXY_API_KEYS=%s\n' \
  "$PROXY_BIND_HOST" "$PROXY_API_KEYS" > ~/.config/madmodel-proxy/service.env
chmod 600 ~/.config/madmodel-proxy/service.env
command -v node
```

将以下内容保存为 `~/.config/systemd/user/madmodel-proxy.service`，把 `/usr/bin/node` 和项目目录替换为实际路径。

```ini
[Unit]
Description=madmodel proxy
StartLimitIntervalSec=120
StartLimitBurst=3

[Service]
Type=simple
WorkingDirectory=%h/madmodel-proxy
EnvironmentFile=%h/.config/madmodel-proxy/service.env
UnsetEnvironment=PROXY_UPSTREAM
ExecStart=/usr/bin/node %h/madmodel-proxy/dashboard.js offcampus
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=15

[Install]
WantedBy=default.target
```

该示例明确使用 WebVPN，并清除继承的 `PROXY_UPSTREAM`。校园网内需要直连时，将 `offcampus` 改为 `campus`。其他自定义配置可加入 `service.env`；需要自定义上游时，还应删除 `UnsetEnvironment` 这一行。

```sh
systemctl --user daemon-reload
systemctl --user enable --now madmodel-proxy
systemctl --user status madmodel-proxy
journalctl --user -u madmodel-proxy -f
```

停止用 `systemctl --user stop madmodel-proxy`，重启用 `systemctl --user restart madmodel-proxy`。systemd 只管理该服务的进程组，无需按端口查找并终止进程。需要退出登录后继续运行或开机启动时，由管理员为该账户启用 linger。

## 排查连接问题

| 现象 | 处理方式 |
|---|---|
| 连接被拒绝或超时 | 确认监听地址、客户端 IP 和端口，检查防火墙是否允许该客户端 |
| API Key 缺失或无效 | 核对客户端密钥与服务端当前配置；更换密钥后双方都要更新 |
| 模型列表可读，但对话失败 | 检查学校登录状态与上游报错，见 [常见问题](../README.md#常见问题) |
| 429 | 降低并发或稍后重试；多个密钥不会增加学校配额 |
| 修改网络选项后仍走旧地址 | 检查是否设置了优先级更高的 `PROXY_UPSTREAM` |
