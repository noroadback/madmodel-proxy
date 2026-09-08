// platform/macos/credentials.js
// macOS 实现:密码与 token 存入登录钥匙串,经系统自带 security 命令行调用,
// 零第三方依赖。非秘密字段(学号/指纹/有效期)留在 JSON 元数据文件——钥匙串
// 是秘密的存储主体,这与 Windows"密文+元数据同文件"形态不同但语义等价。
//
// 纪律与 Windows 侧一致:
//   - 秘密不进 argv(不进进程列表/审计日志):写入走 security 的 stdin 交互模式
//   - 读路径优雅降级:条目不存在/钥匙串锁定时按"无数据"返回 null,不抛——
//     否则 watch 守护会在第一个 readToken 就崩
//   - -T /usr/bin/security:允许 security 自身免提示读取(钥匙串锁定时除外),
//     后台守护无人值守续期依赖这一点

'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { generateFingerprint } = require('../../madmodel-auth');
const { atomicWrite } = require('../file-store');
const { TOKEN_FILE, CREDS_FILE } = require('../paths');

const SERVICE = 'madmodel-proxy';
const ACCOUNT_PASSWORD = 'password';
const ACCOUNT_TOKEN = 'token';

// security 交互解析器按双引号分词,只需转义反斜杠与双引号(密码来自 readline
// 按行读取,不含换行)
function keychainWrite(account, secret) {
  const esc = String(secret).replace(/([\\"])/g, '\\$1');
  const cmd = `add-generic-password -U -s "${SERVICE}" -a "${account}" -w "${esc}" -T /usr/bin/security`;
  execFileSync('security', ['-i'], {
    input: cmd + '\n',
    stdio: ['pipe', 'ignore', 'ignore'],
  });
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
