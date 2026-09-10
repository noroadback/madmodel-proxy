// platform/paths.js
// 状态目录、各状态文件路径——全项目唯一来源。platform 层允许读取
// process.env(core 层禁止);此前的分散计算曾导致口径漂移。
// start.cmd 无法 require 本模块,目录名在其中有一份硬编码,改名需两处同步。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR_NAME = '.madmodel-proxy';
// ≤1.6.0 的旧目录名(项目早期以 dsh 客户端命名),启动时自动迁移,见 migrateStateDir
const LEGACY_DIR_NAME = '.dsh-madmodel';

// MADMODEL_STATE_DIR:状态目录整体重定向(CI 冒烟/测试隔离用,避免触碰真实
// 凭据)。USERPROFILE 未定义时(非 Windows)退回 homedir。不能留 '':path.join('', x)
// 得到相对路径,状态文件会落进当前工作目录——通常就是仓库目录,与 SECURITY.md
// "本仓库目录不写入任何运行时数据"矛盾。
const redirected = process.env.MADMODEL_STATE_DIR || '';
const STATE_DIR = redirected || path.join(process.env.USERPROFILE || os.homedir(), DIR_NAME);

// 旧状态目录 → 现目录的逐文件迁移(≤1.6.0 升级路径):
// - 文件级 rename 天然抗双进程竞态(start.cmd 同窗拉起 watch 与代理,两者
//   都会执行迁移):一方成功,另一方 ENOENT 后跳过,无损坏窗口
// - 锁文件与 shortcut 标记不迁(新目录自建);旧目录迁空后删除,残留
//   (被占用等)无害——新代码不再读它
// - 仅在默认路径下自动执行;MADMODEL_STATE_DIR 重定向时跳过,测试/CI
//   不触碰真实凭据
const MIGRATABLE = ['creds.json', 'token.json', 'api-key', 'last-failed-request.json'];
function migrateStateDir(oldDir, newDir) {
  let moved = 0;
  for (const name of MIGRATABLE) {
    try {
      const from = path.join(oldDir, name);
      const to = path.join(newDir, name);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.mkdirSync(newDir, { recursive: true });
        fs.renameSync(from, to);
        moved += 1;
      }
    } catch (e) {
      // 竞态中另一方已迁走(from 不存在)→静默;真实失败(被占用/权限等)→
      // 告警:文件留在旧目录而新代码不读旧目录,不提示的话凭据未迁入无迹可查
      if (fs.existsSync(path.join(oldDir, name))) {
        console.warn(`[paths] 迁移 ${name} 失败(${e.code || e.message}),文件保留在旧目录 ${oldDir};` +
          '若后续凭据不可用,重跑一次 node refresh-token.js login');
      }
    }
  }
  if (moved > 0) {
    console.log(`[paths] 状态目录已从旧目录迁移(${oldDir} → ${newDir},${moved} 个文件;` +
      '旧目录名是项目早期的历史命名)');
    try { fs.rmdirSync(oldDir); } catch (e) { /* 非空或被占用:残留无害 */ }
  }
  return moved;
}

if (!redirected) {
  const legacy = path.join(process.env.USERPROFILE || os.homedir(), LEGACY_DIR_NAME);
  migrateStateDir(legacy, STATE_DIR);
}

const TOKEN_FILE = path.join(STATE_DIR, 'token.json');
// MADMODEL_CREDS_FILE:测试注入用,避免测试触碰真实凭据
const CREDS_FILE = process.env.MADMODEL_CREDS_FILE || path.join(STATE_DIR, 'creds.json');
const WATCH_LOCK = path.join(STATE_DIR, 'watch.lock');
const AUTH_LOCK = path.join(STATE_DIR, 'auth.lock');

// 面向用户的展示路径:真实绝对路径含用户名,不该进 401 响应体或控制台。
// Windows 惯用 %USERPROFILE% 形态,Unix 惯用 ~ 形态;目录名取实际 STATE_DIR
// 的 basename(重定向时不暴露真实目录名)
function display(file) {
  const dir = path.basename(STATE_DIR);
  return process.platform === 'win32'
    ? `%USERPROFILE%\\${dir}\\${path.basename(file)}`
    : `~/${dir}/${path.basename(file)}`;
}

module.exports = {
  STATE_DIR, TOKEN_FILE, CREDS_FILE, WATCH_LOCK, AUTH_LOCK,
  display, migrateStateDir,
};
