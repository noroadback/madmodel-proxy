// platform/paths.js
// 状态目录、各状态文件路径——全项目唯一来源。platform 层允许读取
// process.env(core 层禁止);此前的分散计算曾导致口径漂移。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// MADMODEL_STATE_DIR:状态目录整体重定向(CI 冒烟/测试隔离用,避免触碰真实
// 凭据)。USERPROFILE 未定义时(非 Windows)退回 homedir。不能留 '':path.join('', x)
// 得到相对路径,状态文件会落进当前工作目录——通常就是仓库目录,与 SECURITY.md
// "本仓库目录不写入任何运行时数据"矛盾。
const STATE_DIR = process.env.MADMODEL_STATE_DIR
  || path.join(process.env.USERPROFILE || os.homedir(), '.dsh-madmodel');

const TOKEN_FILE = path.join(STATE_DIR, 'token.json');
// MADMODEL_CREDS_FILE:测试注入用,避免测试触碰真实凭据
const CREDS_FILE = process.env.MADMODEL_CREDS_FILE || path.join(STATE_DIR, 'creds.json');
const WATCH_LOCK = path.join(STATE_DIR, 'watch.lock');
const AUTH_LOCK = path.join(STATE_DIR, 'auth.lock');

// 面向用户的展示路径:真实绝对路径含用户名,不该进 401 响应体或控制台。
// Windows 惯用 %USERPROFILE% 形态,Unix 惯用 ~ 形态
function display(file) {
  return process.platform === 'win32'
    ? `%USERPROFILE%\\.dsh-madmodel\\${path.basename(file)}`
    : `~/.dsh-madmodel/${path.basename(file)}`;
}

module.exports = {
  STATE_DIR, TOKEN_FILE, CREDS_FILE, WATCH_LOCK, AUTH_LOCK,
  display,
};
