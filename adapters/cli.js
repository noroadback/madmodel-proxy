// adapters/cli.js
// refresh-token.js 的命令分发与终端交互(提示、密码隐藏输入、状态展示)。
// 认证业务在 auth-service.js,存取在 platform/,调度在 core/scheduler.js。
// 命令名保持稳定: login / once / watch / status
// API Key 通过环境变量配置，key 命令只提供指引。

'use strict';

const fs = require('fs');
const readline = require('readline');
const { login, refresh, watch, logout } = require('../auth-service');
const credentials = require('../platform/credentials');
const processLock = require('../platform/process-lock');
const config = require('../config');
const { isProxyRunning } = require('../core/proxy-status');
const { localBaseUrl } = require('../core/listen-config');
const { WATCH_LOCK, display } = require('../platform/paths');

// 密码逐键输入的状态机(纯函数,便于测试)。原实现把这段逻辑内联在
// onData 里,改过真实 bug(粘贴、ESC 序列)却零测试覆盖;抽出来后可断言。
// 参数 escState 与返回的 escState:转义序列跨 chunk 的吞并状态(见函数内注释)
// 返回值:
//   buffer     处理该 chunk 后的缓冲
//   submit     是否遇到回车(调用方据此收尾)
//   cancel     是否遇到 Ctrl+C
//   backspaces 本 chunk 内需回显"退格擦星"的次数(按码点)
//   escState   传给下一次调用的吞并状态
//   codePoints 当前缓冲的码点数(供调用方算星号数,勿用 buffer.length)
function applyPasswordKeys(buffer, chunk, escState) {
  let buf = buffer;
  let submit = false;
  let cancel = false;
  let backspaces = 0;
  // escState 跨 chunk 传递:OS 的 read 分块点不可控,一个转义序列可能被拆到
  // 两次 data 事件里。null=不在序列中;'esc'=刚收到 ESC,等下一个字符判类型;
  // 'csi'=已收到 ESC [,正在吞参数直到终止符;'ss3'=已收到 ESC O,还需再吞一个
  let esc = escState || null;

  for (let i = 0; i < chunk.length; ) {
    const ch = String.fromCodePoint(chunk.codePointAt(i));
    i += ch.length;

    if (esc === 'esc') {
      // 拿到 ESC 之后的第一个字符,判定序列类型。只有 [ (CSI)与 O (SS3)是
      // 已知的序列引导符;其余情形一律视为**孤立的 ESC**——作废吞并状态,
      // 并让当前字符继续走下面的正常处理(不 continue)。
      // 这样用户按 Esc 再继续打字不会静默少吃一个字符(1.9.2 与"一律当序列"
      // 的写法都会吃掉它,症状又是"密码不正确");代价是 ESC + 字母这类少见
      // 序列(Alt+字母 组合)会多出一个字符,比吞掉正常输入安全。
      // 若跟的是控制字符(回车、Ctrl+C)同理——否则按 Esc 再回车提交不了
      if (ch === '[') { esc = 'csi'; continue; }
      if (ch === 'O') { esc = 'ss3'; continue; }
      esc = null; // 孤立 ESC,继续往下按普通字符处理
    }
    if (esc === 'csi') {
      // CSI 的参数与中间字节一直吞,直到 final byte。按 ANSI,CSI 的 final
      // byte 是 0x40-0x7e(@ A-Z [ \ ] ^ _ ` a-z { | } ~ 等),不只是字母与 ~:
      // 只认字母/`~` 会把 ESC[2@(合法的"擦除行"一类) 的 @ 当参数继续吞,
      // 紧随其后的普通字符乃至回车都被吃掉(2026-09-22 审阅指出,实测 ESC[2@b
      // 得 "a" 而非 "ab")
      if (ch >= '@' && ch <= '~') esc = null;
      continue;
    }
    if (esc === 'ss3') {
      // ESC O 引导的 SS3 序列(如 ESC O P / O A):尾字符按 ANSI 也在
      // 0x40-0x7e,吞掉它序列即完整。
      // 但若下一个不是尾字符(回车、Ctrl+C、退格…),说明这不是 SS3 序列,
      // 而是用户按了 Esc 又打大写 O 再按回车——不能把回车当尾字符吞掉,
      // 否则提示挂起、提交不了(2026-09-22 审阅实测:'ab',Esc,O,CR 得
      // submit=false)。此时作废状态,让该字符走下面的正常处理。
      // 代价:Esc 后紧跟大写 O 时那个 O 被丢——该组合极罕见,且"丢 O"远好于
      // "回车失效"
      esc = null;
      if (ch >= '@' && ch <= '~') continue; // 是 SS3 尾字符,吞掉
      // 不是尾字符:不 continue,落到下面按普通字符处理(回车即提交)
    }

    if (ch === '\u001b') {
      esc = 'esc';
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      submit = true;
      break;
    } else if (ch === '\u0003') { // Ctrl+C
      cancel = true;
      break;
    } else if (ch === '\u007f' || ch === '\b') { // 退格:删一个**码点**
      // 不能用 slice(0,-1):那是 UTF-16 码元,删 emoji 会留下半个代理对
      // (实测 '😀' 退格后得 '\ud83d'),缓冲区从此损坏,密码必然认证失败
      // (2026-09-22 审阅指出)。按码点删对 BMP 字符等价,对补充平面安全
      const cps = Array.from(buf);
      if (cps.length) { buf = cps.slice(0, -1).join(''); backspaces++; }
    } else if (ch >= ' ') {
      buf += ch;
    }
  }
  return {
    buffer: buf,
    submit,
    cancel,
    backspaces,
    escState: esc,
    // 缓冲的**码点**数(不是 .length——那是 UTF-16 码元,emoji 会算成 2,
    // 星号数与实际字符数对不上)
    codePoints: Array.from(buf).length,
  };
}

async function promptCredentials() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines = process.stdin.isTTY ? null : rl[Symbol.asyncIterator]();
  const ask = async q => {
    if (!lines) return new Promise(res => rl.question(q, res));
    process.stdout.write(q);
    const line = await lines.next();
    if (line.done) throw new Error('输入已结束，未收到完整凭据。请在终端运行 npm run login。');
    return line.value;
  };
  const username = (await ask('学号: ')).trim();
  if (!username) { console.error('学号不能为空'); process.exit(1); }
  // 隐藏密码输入。TTY:raw mode 逐键读取,不回显(退格/回车正常处理),
  // 纯 Node 不依赖 PowerShell;非 TTY(管道):用 readline 按行读
  const isTTY = !!process.stdin.isTTY;
  let password;
  if (isTTY) {
    // TTY:进密码输入前必须先关 readline——否则它仍以 echo 模式监听 stdin,
    // 把密码字符原样回显到终端(与 * 回显叠加成乱码,退格时两边互相打架)。
    // TTY 下 rl.close 不会结束输入流(与管道模式的关键差异),安全
    rl.close();
    password = await new Promise(resolve => {
      process.stdout.write('统一认证密码（以 * 显示）: ');
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      let buf = '';
      // 跨 chunk 保留转义序列的吞并状态:一次 data 事件可能只送达 ESC 或
      // ESC [ 的一半,下一次才补齐,状态必须在两次调用之间传递
      let escState = null;
      const onData = chunk => {
        const r = applyPasswordKeys(buf, chunk, escState);
        escState = r.escState;
        // 回显:本 chunk 新增的字符各一个 *,退格各一次 退格擦星。
        // 全部按码点算——emoji 在 UTF-16 里占两个码元,用 .length 会多打星号
        const prevCps = Array.from(buf).length;
        const added = r.codePoints - (prevCps - r.backspaces);
        if (added > 0) process.stdout.write('*'.repeat(added));
        for (let k = 0; k < r.backspaces; k++) process.stdout.write('\b \b');
        buf = r.buffer;
        if (r.cancel) {
          process.stdin.setRawMode(false);
          console.error('\n已取消');
          process.exit(130);
        }
        if (r.submit) {
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          process.stdin.pause();
          process.stdout.write('\n');
          resolve(buf);
        }
      };
      process.stdin.on('data', onData);
    });
  } else {
    // 管道环境:输入内容不经过终端,无回显问题。readline 预读缓冲了整个
    // stdin,必须在 readline 上按行读(绕开它的裸监听拿不到被缓冲的数据,
    // 且 rl.close 在管道模式会直接结束输入流——曾导致管道 login 挂死)
    // 管道输入在 Windows 下常带 CRLF 的 \r;只剥 \r 不 trim——首尾空格是
    // 合法密码字符,与 TTY 路径(原样保留)保持一致
    password = (await ask('统一认证密码: ')).replace(/\r$/, '');
  }
  rl.close(); // 凭据都拿到后再释放 stdin
  if (!password) { console.error('密码不能为空'); process.exit(1); }
  return { username, password };
}

// 凭据存储方式的一句话说明(登录成功后展示)。必须与 platform/credentials.js
// 各平台实际实现一致——这是用户对"密码存哪了"的唯一认知来源,说错平台就是
// 说错安全承诺。纯函数(platform 参数可注入)便于测试钉住三平台文案
function storageLabel(platform = process.platform) {
  if (platform === 'win32') return '密码由 Windows DPAPI 按当前账户加密';
  if (platform === 'darwin') return '密码存于当前用户登录钥匙串';
  return '密码按本机标识与 Linux 用户信息加密，主要依赖文件权限保护';
}

async function cmdLogin() {
  const { username, password } = await promptCredentials();
  console.log('\n开始登录并获取 token…');
  const { expiresAt, fingerPrint, tokenFile, credsFile } = await login({ username, password });
  console.log(`✅ token 已获取,有效期至 ${new Date(expiresAt).toLocaleString()}`);
  console.log(`已写入 ${display(tokenFile)}`);
  console.log(`凭据已保存到 ${display(credsFile)}(${storageLabel()})`);
  console.log(`设备指纹: ${fingerPrint.slice(0, 8)}…` +
    '(用于可信设备登记；学校可能再次要求二次认证)');
}

async function cmdOnce() {
  const { expiresAt } = await refresh({ interactive: true });
  console.log(`✅ token 已续期,有效期至 ${new Date(expiresAt).toLocaleString()}`);
}

// 一屏状态:代理、token、watch 与凭据。全部只读。
async function cmdStatus() {
  const proxyUp = await isProxyRunning(config.port, undefined, config.host);
  console.log('代理: ' + (proxyUp ? `运行中 → ${localBaseUrl(config)}/v1` : '未运行（运行 npm start 启动）'));

  // 2) token:三态口径与代理启动横幅一致
  const t = credentials.readToken();
  if (!t) console.log('token: 尚无(先运行: node refresh-token.js login)');
  else {
    const remainMin = Math.round((t.expiresAt - Date.now()) / 60e3);
    const until = new Date(t.expiresAt).toLocaleString();
    if (remainMin <= 0) console.log(`token: 已过期 ${-remainMin} 分钟(至 ${until})`);
    else if (remainMin < 30) console.log(`token: 剩余 ${remainMin} 分钟(即将进入续期窗口)`);
    else console.log(`token: 剩余 ${remainMin} 分钟(至 ${until})`);
  }

  // 3) watch 守护:锁文件 PID 探活(与 acquirePidLock 同一套判定)
  let lockPid = 0;
  try { lockPid = processLock.pidOf(fs.readFileSync(WATCH_LOCK, 'utf8')); } catch (e) { /* 无锁文件 */ }
  const watchAlive = lockPid > 0 && processLock.isAlive(lockPid);
  console.log('watch 续期守护: ' + (watchAlive ? `运行中(PID ${lockPid})`
    : `未运行(随 npm start 启动${lockPid ? ';当前锁文件为死进程残留,下次启动自动接管' : ''})`));

  // 4) 学校登录凭据
  console.log('凭据: ' + (credentials.hasAccount() ? '已配置' : '未配置(node refresh-token.js login)'));
}

// 登出:清除本机保存的全部凭据(密码/token/隧道会话)。TTY 下 y 确认,
// 非 TTY(管道/脚本)需 --yes 显式确认。清除范围与"远端不撤销"的说明
// 在执行前后各出现一次:确认前让用户知道要删什么,完成后交代边界
async function cmdLogout(args) {
  const confirmed = args.includes('--yes');
  if (!confirmed) {
    if (!process.stdin.isTTY) {
      console.error('非交互环境需显式确认: node refresh-token.js logout --yes');
      process.exit(1);
    }
    console.log('将清除本机保存的:统一认证密码、madmodel token、WebVPN 会话(钥匙串条目与加密文件)。');
    console.log('此操作不撤销学校侧的会话；清除后需重新登录。');
    process.stdout.write('继续? [y/N] ');
    const ok = await new Promise(resolve => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      // 同 promptCredentials:一次 data 事件可能是一整串(粘贴"y"+换行),
      // 取第一个可判定的字符即可,否则粘贴确认会被判成"已取消"
      const onData = chunk => {
        process.stdin.setRawMode(false);
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        process.stdout.write('\n');
        for (const ch of chunk) {
          if (ch === '\u0003') { console.error('已取消'); process.exit(130); } // Ctrl+C
          if (ch === '\r' || ch === '\n') break; // 空回车 = 取消
          resolve(ch);
          return;
        }
        resolve('');
      };
      process.stdin.once('data', onData);
    });
    if (ok !== 'y' && ok !== 'Y') { console.log('已取消'); return; }
  }
  const { cleared } = await logout();
  if (!cleared.length) {
    console.log('本机没有已保存的凭据,无需清除');
    return;
  }
  for (const item of cleared) {
    // 钥匙串条目原样展示;文件路径走 display 脱敏(不进日志的习惯延伸)
    console.log(`已清除: ${item.startsWith('钥匙串:') ? item : display(item)}`);
  }
  console.log('本机凭据已清除，此操作不撤销学校侧的会话。');
}

async function runCli(argv) {
  const cmd = argv[0] || 'status';
  try {
    if (cmd === 'login') await cmdLogin();
    else if (cmd === 'once') await cmdOnce();
    else if (cmd === 'watch') await watch();
    else if (cmd === 'logout') await cmdLogout(argv.slice(1));
    else if (cmd === 'status') await cmdStatus();
    else if (cmd === 'key') {
      console.log('请通过 PROXY_API_KEYS 配置代理密钥，设置后重启；未设置时仅支持本机免鉴权访问。');
    }
    else {
      console.log('用法: node refresh-token.js [login|once|watch|logout|status]');
      process.exit(1);
    }
  } catch (e) {
    // 退出码协议:2 = 需要人工处理(凭据失效/要求二次认证),dashboard 据此
    // 停止自动重启、提示重新 login,login 后自动恢复(见 dashboard.js)
    if (e.code === 'BAD_CREDENTIALS' || e.code === 'TWO_FACTOR_REQUIRED') {
      console.error(`❌ [${e.code}] ${e.message}`);
      console.error(e.code === 'TWO_FACTOR_REQUIRED'
        ? '登录链要求二次认证,需人工完成一次: node refresh-token.js login'
        : '凭据已失效(如改过学校密码),需重新登录: node refresh-token.js login');
      process.exit(2);
    }
    console.error(`❌ ${e.code ? `[${e.code}] ` : ''}${e.message}`);
    process.exit(1);
  }
}

module.exports = { runCli, storageLabel, applyPasswordKeys };
