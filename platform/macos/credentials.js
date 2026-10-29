// platform/macos/credentials.js
// macOS 实现:密码与 token 存入登录钥匙串,经系统自带 security 命令行调用,
// 零第三方依赖。非秘密字段(学号/指纹/有效期)留在 JSON 元数据文件——钥匙串
// 是秘密的存储主体,这与 Windows"密文+元数据同文件"形态不同但语义等价。
//
// 纪律与 Windows 侧一致的部分:
//   - 读路径优雅降级:条目不存在/钥匙串锁定时按"无数据"返回 null,不抛——
//     否则 watch 守护会在第一个 readToken 就崩
//   - 创建条目时默认信任创建者 security;更新时保留既有 ACL。
//     不传 -T 或 -A,避免每次续期修改访问许可或放宽权限;钥匙串锁定时仍可能失败
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

// 钥匙串 service 名可经 MADMODEL_KEYCHAIN_SERVICE 覆盖:测试隔离用(冒烟/
// 集成测试注入独立命名空间,与生产条目完全隔离——1.8.1 前冒烟与生产共用
// service 名,在已配置的真机上跑测试会覆盖并清理掉真实凭据)。生产路径
// 不设此变量,恒为默认名
const SERVICE = process.env.MADMODEL_KEYCHAIN_SERVICE || 'madmodel-proxy';
const ACCOUNT_PASSWORD = 'password';
const ACCOUNT_TOKEN = 'token';
// WebVPN 隧道会话 cookie:与 token 同级秘密(凭它可冒用整个 WebVPN 会话),
// 按本文件纪律入钥匙串;token.json 元数据不含它
const ACCOUNT_COOKIE = 'webvpn-cookie';

// 秘密以 base64 编码过钥匙串命令行通道:security CLI 对非 ASCII 的 argv 与
// 输出编码行为不可靠(CI 于 macOS runner 实测,含中文/符号的密码与 token
// 写入成功但读回损坏),base64 是纯 ASCII,对任何编码假设都字节精确。钥匙串
// 条目里存的是 base64 形态(钥匙串访问.app 手动查看所见即此),读回后解码
function keychainWrite(account, secret) {
  const b64 = Buffer.from(String(secret), 'utf8').toString('base64');
  const args = ['add-generic-password', '-U',
    '-s', SERVICE, '-a', account,
    '-w', b64];
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
    const out = execFileSync('security',
      ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return Buffer.from(out.trim(), 'base64').toString('utf8');
  } catch (e) {
    return null;
  }
}

// ===== token 存取 =====
// cookie(webvpn 会话)可选:新链路随 token 一同写入;undefined 表示本次
// 调用方没有新 cookie(如旧格式调用),保留钥匙串既有条目不动
function writeToken(token, expiresAt, cookie) {
  // 先更新钥匙串再动元数据文件:代理按文件 mtime 触发重读,反序会出现
  // "新元数据 + 旧 token"的窗口
  keychainWrite(ACCOUNT_TOKEN, token);
  if (cookie !== undefined) keychainWrite(ACCOUNT_COOKIE, cookie);
  atomicWrite(TOKEN_FILE, JSON.stringify({
    v: 1,
    expiresAt,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

// 返回 { token, expiresAt, cookie? } 或 null;坏记录返回 null 让调用方按"无 token"处理。
// cookie 缺条目(升级前旧状态)时字段缺省,调用方按"无隧道凭证"处理
function readToken() {
  try {
    const meta = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    const token = keychainRead(ACCOUNT_TOKEN);
    if (!token || !Number.isFinite(meta.expiresAt)) return null;
    const cookie = keychainRead(ACCOUNT_COOKIE);
    return cookie
      ? { token, expiresAt: meta.expiresAt, cookie }
      : { token, expiresAt: meta.expiresAt };
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

// ===== 登出:清除本工具的全部本地凭据 =====
// 钥匙串三条目(密码/token/webvpn 会话 cookie)逐一删除,再删两个元数据
// 文件;返回清除清单。只操作本工具的条目与文件,不触碰任何其他钥匙串
// 内容。本机清除 ≠ 远端会话撤销:学校侧登录状态活到自然过期
function clearAll() {
  const cleared = [];
  for (const account of [ACCOUNT_PASSWORD, ACCOUNT_TOKEN, ACCOUNT_COOKIE]) {
    try {
      execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', account],
        { stdio: ['ignore', 'ignore', 'ignore'] });
      cleared.push(`钥匙串:${account}`);
    } catch (e) { if (e.status !== 44) throw new Error('钥匙串条目清除失败，请检查钥匙串权限。'); }
  }
  for (const file of [TOKEN_FILE, CREDS_FILE]) {
    try {
      fs.unlinkSync(file);
      cleared.push(file);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return cleared;
}

module.exports = {
  readToken, writeToken,
  readAccount, writeAccount, hasAccount, clearAll,
};
