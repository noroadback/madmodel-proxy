# 局域网多机部署：madproxy + codewhale（THU-CVML 实战笔记）

把清华 madmodel（DeepSeek）经 madproxy 变成**局域网可访问、带 API Key 鉴权**的
OpenAI 端点，多台机器（含本机笔记本）用 codewhale 接入。本文是踩过坑后的可复现流程。

## 架构

```
codewhale / OpenAI 客户端
      │  http://<机器IP>:18987/v1   Authorization: Bearer <key>
      ▼
madproxy (dashboard.js: proxy + watch 续期)   ← 本仓库
      │  PROXY_BIND_HOST=0.0.0.0  PROXY_API_KEYS=<key>
      │  PROXY_UPSTREAM=校园网直连(madmodel.cs) 或 默认 WebVPN 隧道
      ▼
清华 madmodel 上游
```

- **鉴权与对外监听在 madproxy 本体内实现**（`config.js` + `adapters/http-server.js`），
  不是外挂网关。见根 README 环境变量表。
- 非回环监听（`0.0.0.0`）时 Host 白名单让位给 API Key；回环默认行为不变。

## 一次性部署（每台机器）

前提：Node ≥ 18（本项目零依赖，clone 即用）、能连 GitHub（装 codewhale 二进制）。

### 1. madproxy 源码

```sh
mkdir -p ~/dsh-combo && cd ~/dsh-combo
git clone https://github.com/THU-CVML/madmodel-proxy.git
```

### 2. 凭据（跨机复制，不必每台重新 login）

凭据是**机器绑定加密**的（Linux: `/etc/machine-id` + uid 派生 AES-256-GCM），
直接拷 `~/.madmodel-proxy/*.json` 到别的机器解不开。正确做法是**明文中转 + 目标机重新加密**：

```sh
# 在已有凭据的源机(如 22)导出:
node -e 'const c=require("./platform/credentials");const a=c.readAccount(),t=c.readToken();
  require("fs").writeFileSync("/tmp/xfer.json",JSON.stringify({account:a,token:t}),{mode:0o600})'
# 拷 /tmp/xfer.json 到目标机(经共享盘或 scp),然后在目标机:
node -e 'const c=require("./platform/credentials");const x=require("/tmp/xfer.json");
  c.writeAccount(x.account.username,x.account.password,x.account.fingerPrint);
  if(x.token)c.writeToken(x.token.token,x.token.expiresAt,x.token.cookie)'
shred -u /tmp/xfer.json   # 用完抹除明文
```

> **单会话陷阱**：同一学号的 WebVPN 会话是**单点**的——多台机器同时跑 watch 续期
> 会互相把对方会话踢掉，症状是「聊一会儿就 502」。**一个学号只在一台机器跑**，
> 或每台配独立学号。（2026-09 实测，见 project_history。）

### 3. API Key

```sh
mkdir -p ~/.madmodel-proxy
printf 'madk-%s\n' "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" > ~/.madmodel-proxy/api-keys
chmod 600 ~/.madmodel-proxy/api-keys
```

### 4. 启动（幂等脚本）

```sh
cd ~/dsh-combo/madmodel-proxy
./scripts/service.sh start      # 默认: 0.0.0.0:18987 + key(读上面文件) + 校园网直连
./scripts/service.sh status
./scripts/service.sh restart
./scripts/service.sh stop
```

对外监听但没配 key 时脚本**拒绝启动**（防裸奔）。覆盖用环境变量：
`MADPROXY_PORT` / `MADPROXY_BIND` / `MADPROXY_API_KEYS` / `MADPROXY_UPSTREAM`
（`MADPROXY_UPSTREAM=tunnel` 走 WebVPN；默认校园网直连 madmodel.cs）。

## codewhale 接入（含本机笔记本走局域网）

### 装二进制

```sh
npm install -g codewhale        # 下载平台二进制并按 sha256 校验
```

> GitHub 慢时（校内节点实测 ~50KB/s）：`CODEWHALE_DISABLE_INSTALL=1 npm i -g codewhale`
> 先装壳，再把别处校验过的同版本二进制拷进
> `~/.npm-global/lib/node_modules/codewhale/bin/downloads/{codewhale,codew}`（sha256 需与
> release 的 `codewhale-artifacts-sha256.txt` 一致），写 `codewhale.version`/`codew.version`
> 后 `codewhale --version` 会自动 adopt，不再联网。

### 配置（关键：用命名 provider，避开环境变量冲突）

**坑**：若用 `provider = "openai"`，codewhale 会被 shell 里已有的
`OPENAI_BASE_URL` / `OPENAI_API_KEY` 环境变量劫持（本机指向 ebill 就会连错端点，
报 `Custom endpoint credentials must be bound explicitly`）。**用自定义命名 provider +
内联 api_key** 绕开：

```toml
# ~/.codewhale/config.toml
provider = "thu88"

[providers.thu88]
kind = "openai-compatible"
base_url = "http://10.103.10.88:18987/v1"   # 88 的局域网地址
model = "DeepSeek-V4-Flash-0731"
context_window = 262144
api_key = "madk-...."                          # 与 88 上 ~/.madmodel-proxy/api-keys 一致
```

回环 http 需要 `export DEEPSEEK_ALLOW_INSECURE_HTTP=1`（非回环 http 亦然）。

### 验证

```sh
codewhale --version
codewhale exec "只回复五个字:本机连通88"      # 通则回你要的话
```

## 排障速查

| 症状 | 原因 / 处理 |
|---|---|
| 聊一会儿就 502「上游返回无法识别的响应」 | WebVPN 隧道会话被同学号别处登录踢掉。**一学号一机**，或改校园网直连 `MADPROXY_UPSTREAM`(默认已直连) |
| codewhale 报 `credentials must be bound explicitly` 且 URL 是 ebill | 被 `OPENAI_BASE_URL` 环境变量劫持。改用命名 provider + 内联 `api_key`(见上) |
| 413「请求体超过上限」 | body > 950KB(nginx 1MB 硬限)。这是字节上限不是 token 上限；5.4 万 token 实测正常 |
| 对外 curl `000` 无响应 | 检查 `PROXY_BIND_HOST=0.0.0.0`(默认 127.0.0.1 仅本机);`ss -tlnp | grep 18987` 看实际绑定 |
| `timeout node ...` 报 EPERM | 某些节点有 seccomp guard。别用 timeout 包 node,直接跑 |
| WebVPN 登录反复「未见会话」 | 短时高频登录触发频控,或触发二次认证。停手冷却,交互式 `node refresh-token.js login` 走验证码 |

## 上下游端口约定（本部署）

- madproxy 对外：`0.0.0.0:18987`
- 88 局域网地址：`http://10.103.10.88:18987/v1`
- `GET /healthz` 恒免鉴权，回 `ok`，供探活/Makefile 用
