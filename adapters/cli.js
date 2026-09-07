// adapters/cli.js
// refresh-token.js 的命令分发与终端交互(提示、密码隐藏输入、状态展示)。
// 认证业务在 auth-service.js,存取在 platform/,调度在 core/scheduler.js。
// 命令名与输出文案保持稳定:login / once / watch / status / key

'use strict';

const fs = require('fs');
const readline = require('readline');
const { login, refresh, watch } = require('../auth-service');
const credentials = require('../platform/credentials');
const processLock = require('../platform/process-lock');
const config = require('../config');
const { WATCH_LOCK, resolveApiKey } = require('../platform/paths');

async function promptCredentials() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(res => rl.question(q, res));
  const username = (await ask('学号: ')).trim();
  if (!username) { console.error('学号不能为空'); process.exit(1); }
  // 隐藏密码输入。TTY:raw mode 逐键读取,不回显(退格/回车正常处理),
  // 纯 Node 不依赖 PowerShell;非 TTY(管道):同样用 readline 按行读——
  // 陷阱:管道模式 readline 会预读缓冲整个 stdin,rl.close() 还会结束
  // 输入流,绕开 readline 的裸 stdin 监听既拿不到被缓冲的行、也会挂死,
  // 所以这里统一走 rl.question,close 放到最后
  const isTTY = !!process.stdin.isTTY;
  let password;
  if (isTTY) {
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
    // 管道环境:输入内容不经过终端,无回显问题
    password = (await ask('统一认证密码(输入不显示): ')).trim();
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
  console.log(`已写入 ${tokenFile}`);
  console.log(`凭据已保存到 ${credsFile}(密码仅当前 Windows 账户可解密)`);
  console.log(`设备指纹: ${fingerPrint.slice(0, 8)}…` +
    '(首次登录可能触发二次认证,验证一次后免认证;完整指纹存于本地凭据文件)');
}

async function cmdOnce() {
  const { expiresAt } = await refresh({ interactive: true });
  console.log(`✅ token 已续期,有效期至 ${new Date(expiresAt).toLocaleString()}`);
}

// 一屏状态:代理/token/watch/key 四问四答。全部只读,可随时运行。
async function cmdStatus() {
  // 1) 代理:/v1/models 在鉴权之前、无需 key;返回 DeepSeek-V4-Flash
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

  // 4) 凭据与 key(优先级由 paths.resolveApiKey 统一裁定,与代理同源)
  console.log('凭据: ' + (credentials.hasAccount() ? '已配置' : '未配置(node refresh-token.js login)'));
  const keyState = {
    disabled: '鉴权已关闭(PROXY_NO_AUTH=1),key 不参与鉴权',
    env: '环境变量 PROXY_API_KEY 已设置(优先于文件)',
    file: '已生成(查看: node refresh-token.js key)',
    none: '未生成(首次启动代理时自动生成)',
  };
  console.log('API key: ' + keyState[resolveApiKey().source]);
}

function cmdKey() {
  const { key, source } = resolveApiKey();
  if (source === 'disabled') {
    console.log('本地鉴权已关闭(PROXY_NO_AUTH=1),key 不参与鉴权。');
    return;
  }
  if (source === 'none') {
    console.log('尚无 API key——首次启动代理时自动生成(双击 start.cmd 或 node proxy.js)。');
    console.log('也可用环境变量 PROXY_API_KEY 指定自定义 key。');
    return;
  }
  console.log(key);
  if (source === 'env') console.log('(来自环境变量 PROXY_API_KEY,优先于 key 文件)');
}

async function runCli(argv) {
  const cmd = argv[0] || 'status';
  try {
    if (cmd === 'login') await cmdLogin();
    else if (cmd === 'once') await cmdOnce();
    else if (cmd === 'watch') await watch();
    else if (cmd === 'status') await cmdStatus();
    else if (cmd === 'key') cmdKey();
    else {
      console.log('用法: node refresh-token.js [login|once|watch|status|key]');
      process.exit(1);
    }
  } catch (e) {
    console.error(`❌ ${e.code ? `[${e.code}] ` : ''}${e.message}`);
    process.exit(1);
  }
}

module.exports = { runCli };
