#!/usr/bin/env node
// refresh-token.js
// CLI 入口:配置凭据(首次) + 手动/自动续期 madmodel token。
// token 写入 %USERPROFILE%\.dsh-madmodel\token.json,反代热加载。
//
// 用法:
//   node refresh-token.js login          # 首次配置:输入学号密码,保存并取一次 token
//   node refresh-token.js once           # 用已存凭据取一次新 token
//   node refresh-token.js watch          # 常驻:到期前 30 分钟自动续,失败退避重试
//   node refresh-token.js status         # 一屏查看运行状态(代理/token/watch)
//
// 命令分发与终端交互在 adapters/cli.js,认证业务在 auth-service.js,
// 调度状态机在 core/scheduler.js。

'use strict';

const { runCli } = require('./adapters/cli');

runCli(process.argv.slice(2));
