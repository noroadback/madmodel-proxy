// platform/macos/credentials.js
// macOS 实现:密码与 token 存入登录钥匙串,经系统自带 security 命令行调用,
// 零第三方依赖。非秘密字段(学号/指纹/有效期)留在 JSON 元数据文件——钥匙串
// 是秘密的存储主体,这与 Windows"密文+元数据同文件"形态不同但语义等价。
//
// 纪律与 Windows 侧一致的部分:
//   - 读路径优雅降级:条目不存在/钥匙串锁定时按"无数据"返回 null,不抛——
//     否则 watch 守护会在第一个 readToken 就崩
//   - -T /usr/bin/security:允许 security 自身免提示读取(钥匙串锁定时除外),
//     后台守护无人值守续期依赖这一点
// 与 Windows 侧不同的取舍:秘密经 argv 送入 security。macOS 没有 stdin 通道
// 可喂它,`-i` 交互模式的引号转义语义不可依赖(CI 实测失败);execFileSync
// 不经 shell、argv 由 execve 原样传递,无解析歧义。代价是秘密在本进程
// argv 中存在毫秒级窗口,仅同用户可见——如实记录,不假装等价于 stdin。

'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { generateFingerprint } = require('../../madmodel-auth');
const { atomicWrite } = require('../file-store');
const { TOKEN_FILE, CREDS_FILE } = require('../paths');

const SERVICE = 'madmodel-proxy';
const ACCOUNT_PASSWORD = 'password';
const ACCOUNT_TOKEN = 'token';

function keychainWrite(account, secret) {
  const args = ['add-generic-password', '-U',
    '-s', SERVICE, '-a', account,
    '-w', String(secret),
    '-T', '/usr/bin/security'];
  try {
    execFileSync('security', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    // stderr 带上来:钥匙串问题(lockdown/权限/参数)在 CI 与真机上都要能自诊断;
    // security 的报错文案不回显 -w 的值
    const detail = e.stderr ? e.stderr.toString().trim() : e.message;
    throw new Error(`钥匙串写入失败: ${detail}`);
  }
}

// 条目不存在/钥匙串锁定:security 非零退出,按无数据处理
function keychainRead(account) {
  try {
    return execFileSync('security',
      ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trimEnd();
  } catch (e) {
    return null;
  }
}

// ===== token 存取 =====
function writeToken(token, expiresAt) {
  // 先更新钥匙串再动元数据文件:代理按文件 mtime 触发重读,反序会出现
  // "新元数据 + 旧 token"的窗口
  keychainWrite(ACCOUNT_TOKEN, token);
  atomicWrite(TOKEN_FILE, JSON.stringify({
    v: 1,
    expiresAt,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

// 返回 { token, expiresAt } 或 null;坏记录返回 null 让调用方按"无 token"处理
function readToken() {
  try {
    const meta = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    const token = keychainRead(ACCOUNT_TOKEN);
    if (!token || !Number.isFinite(meta.expiresAt)) return null;
    return { token, expiresAt: meta.expiresAt };
  } catch (e) {
    return null;
  }
}

// ===== 账号凭据存取(学号/密码/设备指纹) =====
function readAccount() {
  if (!fs.existsSync(CREDS_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    if (!raw.username || !raw.fingerPrint) return null;
    // 元数据在而钥匙串条目丢失:按未配置处理,引导用户重新 login
    const password = keychainRead(ACCOUNT_PASSWORD);
    if (!password) return null;
    return {
      username: raw.username,
      password,
      fingerPrint: raw.fingerPrint,
      updatedAt: raw.updatedAt,
    };
  } catch (e) {
    // 固定文案:e.message 可能携带文件内容,不该进日志
    console.error('凭据读取失败(可能钥匙串条目被删或文件损坏),可重新运行 login 配置');
    return null;
  }
}

function writeAccount(username, password, fingerPrint) {
  const record = {
    username,
    fingerPrint: fingerPrint || generateFingerprint(),
    updatedAt: new Date().toISOString(),
  };
  keychainWrite(ACCOUNT_PASSWORD, password);
  atomicWrite(CREDS_FILE, JSON.stringify(record, null, 2));
  // 密码只进内存与钥匙串
  return {
    username: record.username,
    password,
    fingerPrint: record.fingerPrint,
  };
}

// 钥匙串才是凭据主体:文件存在不等于凭据可用,以能否完整读回为准
function hasAccount() {
  return readAccount() !== null;
}

module.exports = {
  readToken, writeToken,
  readAccount, writeAccount, hasAccount,
};
