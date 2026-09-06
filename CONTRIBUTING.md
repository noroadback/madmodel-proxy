# 贡献指南(CONTRIBUTING.md)

感谢你愿意为 madmodel-proxy 做贡献。这是一个零 npm 依赖、Windows 优先的小项目,贡献门槛刻意保持得很低:clone 即用、`npm test` 全离线。

## 开发环境要求

- **Node.js >= 18.14**(`fetch` / `AbortController` / `crypto.timingSafeEqual` 依赖此版本线;CI 在 18/20/22/24 上跑测试);
- **Windows 10/11**:凭据与 token 的静态加密用 DPAPI,登录链实测于 Windows。Linux/macOS 上 `npm test` 仍可运行(`test-creds.js` 自识别平台跳过 DPAPI 部分),但完整功能仅 Windows;
- **Git**:注意本仓库 `.gitattributes` 锁定了换行策略,提交前不要改动它。

## 安装与运行

```bat
git clone https://github.com/noroadback/madmodel-proxy.git
cd madmodel-proxy
:: 无需 npm install——零运行时依赖
node proxy.js          :: 或 start.cmd 单窗口模式
```

首次使用需要配置凭据(`node refresh-token.js login`,需清华统一认证账号);纯开发/测试不需要账号。

## 运行测试

```bat
npm test
```

- **全程离线**:不访问真实上游、不需要账号、不消耗配额。放心在任何网络环境运行。
- 套件构成:`test-creds.js`(DPAPI 往返)+ `node --test` 单元测试(config/limits/sse/payload/aggregator/errors/upstream/wakeup)+ `test-proxy.js`(假上游 + 子进程端到端)。
- 任何失败都以非零退出码结束,可直接用于 CI。
- `npm run smoke`(`smoke-real.js`)是**真实流量冒烟**:需要代理在线、有效 token,并消耗少量配额——它不属于离线测试,改动 SSE 解析/错误处理/超时等协议行为时才需要跑,并需要你自行准备真实环境。

## 如何添加单元测试

- 单元测试用 Node 原生 `node:test` + `node:assert/strict`,放仓库根目录,命名 `test-<模块名>.js`;
- 纯逻辑模块(config/limits/sse/payload/aggregator/errors)直接 `require` 被测模块,不起网络、不碰文件系统(除临时目录);
- 涉及 HTTP 的模块(如 upstream)用 `http.createServer` 在 `127.0.0.1` 随机端口起假上游,测试结束 `server.close()`;
- 涉及环境变量的模块(config)用 `child_process.execFile` 起子进程隔离 `process.env`——`config.js` 在 require 时读环境,同进程内无法重置;
- 新文件记得加进 `package.json` 的 `test` 脚本 `node --test` 文件列表;
- 端到端用例(`test-proxy.js`)以子进程方式注入环境变量,入口文件名(`proxy.js` / `refresh-token.js`)不可改名。

## 提交 Issue

- 报 bug 请附:操作系统版本、Node 版本(`node -v`)、相关日志(注意先脱敏,见下);
- 上游行为类问题(错误翻译、SSE 帧型)请附代理访问日志中该请求的那一行,以及上游错误原文;
- 登录链问题请注明"实测日期"——学校端点改版会让协议失效,日期是排查的第一线索。

## 提交 Pull Request

1. 先开 issue 描述意图,避免和进行中的工作撞车;
2. fork / 分支 → 修改 → `npm test` 全绿 → 提交 PR;
3. PR 描述里写明:改了什么行为、怎么验证的(离线测试 / 冒烟 / 真实使用);
4. 涉及协议行为的改动,合并前需要真实流量冒烟通过(维护者执行或你自证)。

## 绝对不要提交的内容

以下任何一项出现在 PR 里都会被直接拒绝:

- **token / 密码 / API key**:包括你本机的 `token.json`、`creds.json`、`api-key` 内容,以及日志/截图里的 Bearer 头、学号、密码;
- **真实请求体**:对话内容属于隐私,`DUMP_FAILED=1` 产生的 `last-failed-request.json` 绝不能入库;
- **本地状态文件**:`~/.dsh-madmodel/` 下的一切(`.gitignore` 已有防御性兜底,不要绕过);
- **测试里的真实端点或真实账号**:测试注入一律用 `PROXY_UPSTREAM` / `PROXY_TOKEN_FILE` / `MADMODEL_CREDS_FILE` 指向本地假对象。

不确定时先看 [SECURITY.md](SECURITY.md) 的数据流向表,或在 issue 里问。
