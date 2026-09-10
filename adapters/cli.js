// adapters/cli.js
// refresh-token.js 的命令分发与终端交互(提示、密码隐藏输入、状态展示)。
// 认证业务在 auth-service.js,存取在 platform/,调度在 core/scheduler.js。
// 命令名保持稳定: login / once / watch / status
// (key 命令已随本地鉴权一并移除,保留一声友好提示)

'use strict';

const fs = require('fs');
const readline = require('readline');
const { login, refresh, watch } = require('../auth-service');
const credentials = require('../platform/credentials');
const processLock = require('../platform/process-lock');
const config = require('../config');
const { WATCH_LOCK, display } = require('../platform/paths');

async function promptCredentials() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(res => rl.question(q, res));
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
      process.stdout.write('统一认证密码(输入不显示): ');
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      let buf = '';
      const onData = ch => {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          process.stdin.pause();
          process.stdout.write('\n');
          resolve(buf);
        } else if (ch === '\u0003') { // Ctrl+C
          process.stdin.setRawMode(false);
          console.error('\n已取消');
          process.exit(130);
        } else if (ch === '\u007f' || ch === '\b') { // 退格
          if (buf) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); }
        } else if (ch >= ' ') {
          buf += ch;
          process.stdout.write('*');
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
    password = (await ask('统一认证密码(输入不显示): ')).replace(/\r$/, '');
  }
  rl.close(); // 凭据都拿到后再释放 stdin
  if (!password) { console.error('密码不能为空'); process.exit(1); }
  return { username, password };
}

async function cmdLogin() {
  const { username, password } = await promptCredentials();
  console.log('\n开始登录并获取 token…');
  const { expiresAt, fingerPrint, tokenFile, credsFile } = await login({ username, password });
  console.log(`✅ token 已获取,有效期至 ${new Date(expiresAt).toLocaleString()}`);
  console.log(`已写入 ${display(tokenFile)}`);
  console.log(`凭据已保存到 ${display(credsFile)}(密码仅当前 Windows 账户可解密)`);
  console.log(`设备指纹: ${fingerPrint.slice(0, 8)}…` +
    '(首次登录可能触发二次认证,验证一次后免认证;完整指纹存于本地凭据文件)');
}

async function cmdOnce() {
  const { expiresAt } = await refresh({ interactive: true });
  console.log(`✅ token 已续期,有效期至 ${new Date(expiresAt).toLocaleString()}`);
}

// 一屏状态:代理/token/watch/key 四问四答。全部只读,可随时运行。
async function cmdStatus() {
  // 1) 代理:/v1/models 在鉴权之前、无需 key;返回配置的模型列表
  //    即确认是本代理在监听(而非端口被其他程序占用)
  let proxyUp = false;
  try {
    const r = await fetch(`http://127.0.0.1:${config.port}/v1/models`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json().catch(() => null);
    proxyUp = r.status === 200 && Array.isArray(j?.data) && j.data.some(m => m.id === config.model);
  } catch (e) { /* 未运行/超时/非本代理 */ }
  console.log('代理: ' + (proxyUp ? `运行中 → http://127.0.0.1:${config.port}/v1` : '未运行(双击 start.cmd 启动)'));

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
    : `未运行(随 start.cmd 启动${lockPid ? ';当前锁文件为死进程残留,下次启动自动接管' : ''})`));

  // 4) 凭据(本地无鉴权,代理不设 key,客户端 API key 填任意值)
  console.log('凭据: ' + (credentials.hasAccount() ? '已配置' : '未配置(node refresh-token.js login)'));
}

async function runCli(argv) {
  const cmd = argv[0] || 'status';
  try {
    if (cmd === 'login') await cmdLogin();
    else if (cmd === 'once') await cmdOnce();
    else if (cmd === 'watch') await watch();
    else if (cmd === 'status') await cmdStatus();
    else if (cmd === 'key') {
      console.log('代理本地无鉴权,已无 key 命令;客户端 API key 填任意值。');
    }
    else {
      console.log('用法: node refresh-token.js [login|once|watch|status]');
      process.exit(1);
    }
  } catch (e) {
    console.error(`❌ ${e.code ? `[${e.code}] ` : ''}${e.message}`);
    process.exit(1);
  }
}

module.exports = { runCli };
