// platform/paths.js
// 状态目录、各状态文件路径、以及本地鉴权 key 的解析优先级——全项目唯一来源。
// platform 层允许读取 process.env(core 层禁止);此前的分散计算曾导致优先级
// 口径漂移(test-proxy.js 第 15 节的两个用例就是为此加的)。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// USERPROFILE 未定义时(非 Windows)退回 homedir。不能留 '':path.join('', x)
// 得到相对路径,状态文件会落进当前工作目录——通常就是仓库目录,与 SECURITY.md
// "本仓库目录不写入任何运行时数据"矛盾。
const STATE_DIR = path.join(process.env.USERPROFILE || os.homedir(), '.dsh-madmodel');

const TOKEN_FILE = path.join(STATE_DIR, 'token.json');
const KEY_FILE = path.join(STATE_DIR, 'api-key');
// MADMODEL_CREDS_FILE:测试注入用,避免测试触碰真实凭据
const CREDS_FILE = process.env.MADMODEL_CREDS_FILE || path.join(STATE_DIR, 'creds.json');
const WATCH_LOCK = path.join(STATE_DIR, 'watch.lock');
const AUTH_LOCK = path.join(STATE_DIR, 'auth.lock');

// 面向用户的展示路径:真实绝对路径含 Windows 账户名,不该进 401 响应体或控制台
function display(file) {
  return `%USERPROFILE%\\.dsh-madmodel\\${path.basename(file)}`;
}

// 本地鉴权 key 的解析优先级,代理与各 CLI 共用一份:
// PROXY_NO_AUTH=1 > PROXY_API_KEY > key 文件。source 供诊断命令区分口径;
// envOverridden 标记"NO_AUTH 生效但 PROXY_API_KEY 也设置了"的误导性配置。
function resolveApiKey() {
  if (process.env.PROXY_NO_AUTH === '1') {
    return { key: '', source: 'disabled', envOverridden: !!process.env.PROXY_API_KEY };
  }
  if (process.env.PROXY_API_KEY) return { key: process.env.PROXY_API_KEY, source: 'env' };
  try {
    const key = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (key) return { key, source: 'file' };
  } catch (e) { /* 尚无文件 */ }
  return { key: '', source: 'none' };
}

module.exports = {
  STATE_DIR, TOKEN_FILE, KEY_FILE, CREDS_FILE, WATCH_LOCK, AUTH_LOCK,
  display, resolveApiKey,
};
