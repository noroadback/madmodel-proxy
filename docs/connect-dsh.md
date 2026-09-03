# 接入 dsh(首次配置指南)

madmodel-proxy 把清华 madmodel 服务(网页形态、token 约 5 小时过期)转换为一个**本机常驻的 OpenAI 兼容端点**。本文描述从零到 dsh 可用的完整流程,预计 5 分钟。

> **测试状态**:本流程已在 Windows 11 + Node.js 24 + dsh 实测通过。
> 代理对客户端只暴露标准 OpenAI 协议(`/v1/chat/completions`、`/v1/models`),
> 其他 OpenAI 兼容客户端理论上同样可用,但**未逐一验证**——欢迎在 issue 中
> 附上你的客户端类型与结果。

## 前置条件

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10/11(凭据与 token 经 Windows DPAPI 加密存储,暂不支持 macOS/Linux) |
| Node.js | ≥ 18.14(终端执行 `node -v` 确认;版本过低时程序启动即明确报错) |
| 账号 | 清华统一认证(学号 + 密码;首次登录可能触发二次认证) |
| 客户端 | 已安装 dsh |

本工具**零第三方依赖**,clone 后无需 `npm install`。

## 第 1 步:保存凭据,获取首个 token

```bat
node refresh-token.js login
```

按提示输入学号和统一认证密码(密码输入不回显)。

**首次登录大概率要求二次认证**(新设备验证):终端会列出可用验证方式
(微信 / 手机短信 / TOTP 动态码),输入序号选择,收到验证码后输入六位数字。
验证通过后,本机的设备指纹会登记为学校侧可信设备——**之后的自动续期不再需要
二次认证**,所以这一步只需要做一次。

成功标志:

```
✅ token 已获取,有效期至 2026/9/3 15:15:13
```

此时本地已生成凭据文件(位于 `%USERPROFILE%\.dsh-madmodel\`):

| 文件 | 内容 | 保护方式 |
|---|---|---|
| `creds.json` | 学号 + 密码 + 设备指纹 | DPAPI 加密,仅当前 Windows 账户可解密 |
| `token.json` | madmodel API token | DPAPI 加密 |

**关于密码安全**:密码只以两种形态存在——本机 DPAPI 密文,以及发往
`id.tsinghua.edu.cn` 的 SM2 加密报文(学校登录协议本身的要求)。不经任何第三方
服务,不写日志。

## 第 2 步:启动代理

双击 **`start.cmd`**。它会依次:

1. 检查 8080 端口——已有实例在跑则直接退出,不会重复启动;
2. 启动 token 续期守护(最小化窗口;到期前 30 分钟自动续期);
3. 前台启动代理,看到如下输出即成功:

```
madmodel 反代已启动: http://127.0.0.1:8080/v1
模型: DeepSeek-V4-Flash
本地鉴权: 已启用(本次生成随机 key,客户端 Bearer key 见: C:\Users\<你>\.dsh-madmodel\api-key)
当前 token 剩余 272 分钟
```

首次启动会自动生成一个随机 API key——**接下来 dsh 要用的就是它**。
(此时 `api-key` 文件已生成,第 3 步直接读取它。)

## 第 3 步:获取 API key

```bat
node refresh-token.js key
```

输出一串 32 字符的随机串,复制备用。等效方式:`type %USERPROFILE%\.dsh-madmodel\api-key`。

## 第 4 步:配置 dsh

在 dsh 的供应商(Provider)配置中,新建或编辑一条 OpenAI 兼容配置:

| 配置项 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:8080/v1` |
| API Key | 第 3 步复制的完整字符串(**不是** `local` 之类的占位符) |
| 模型名 | `DeepSeek-V4-Flash` |

> 代理默认强制校验 Bearer key(防止本机恶意网页盗用上游配额)。
> 如果你的 dsh 里沿用了旧版代理时代的占位符(如 `local`),务必换成真实 key,
> 否则所有请求都会收到 401。

## 第 5 步:验证

在 dsh 里随便发一条消息,收到回复即全部完成。

想先单独确认代理存活,可以(此检查端点不需要 key):

```bat
curl http://127.0.0.1:8080/v1/models
```

返回 `{"object":"list","data":[{"id":"DeepSeek-V4-Flash",…}]}` 即代理正常,
此时问题只会出在 dsh 的 key/模型名配置上。

## 日常运行须知

- **保持 start.cmd 的窗口开着**(最小化即可);关机/重启后重新双击。
- **token 全自动**:到期前 30 分钟自动续期,代理热加载新 token。你不需要做任何事,可以忘了这回事。
- **重复双击无害**:单实例锁自动探活,旧守护死了新守护接管。
- **改了统一认证密码**:续期守护连续 3 次登录失败会自动退出并给出提示,
  重新执行第 1 步(`login`)即可,其他配置不受影响。

## 故障排查

| 现象 | 含义 | 处理 |
|---|---|---|
| dsh 报 401"无效或缺失 API key" | key 没配或配错 | `node refresh-token.js key` 重新复制 |
| dsh 报 401"token 已过期" | 续期守护没在运行 | 看最小化的 watch 窗口是否存活,死了就重开 start.cmd |
| dsh 报 503 | 本地无 token | 没做过第 1 步,或 watch 窗口里有报错 |
| dsh 报 429 | 触发代理限速(60 次/分钟 / 并发 8) | 稍等重试;agent 失控时可暂时关掉代理 |
| dsh 报 5xx 且提示上游拒绝 | madmodel 服务端问题 | 与本工具无关,稍后再试 |

## 进阶

- 换端口、自定义 key、关闭鉴权:`PROXY_PORT` / `PROXY_API_KEY` / `PROXY_NO_AUTH` 环境变量(见 README)。
- 接入其他 OpenAI 兼容客户端:配置方式与 dsh 完全一致(Base URL + key + 模型名)。
