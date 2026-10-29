// test/cli-password-input.test.js — 密码逐键输入状态机(applyPasswordKeys)。
//
// 为什么需要:这段逻辑原内联在 promptCredentials 的 onData 里,改过真实 bug
// (粘贴整串含回车、ESC 转义序列)却零测试覆盖;而旁边 4 行的 storageLabel
// 倒有三条测试(2026-09-21 审阅指出的不对称)。抽成纯函数后,把这几类输入
// 逐个钉住,防止"修 A 引入 B"再次发生(逐码点修好粘贴,却引入方向键污染)。
'use strict';
require('../scripts/isolated-env').isolate();

const test = require('node:test');
const assert = require('node:assert');

const { applyPasswordKeys, validatePasswordTerminal } = require('../adapters/cli');

test('Windows 的非 TTY Git Bash 输入在读取凭据前被拒绝', () => {
  for (const env of [{ MSYSTEM: 'MINGW64' }, { MINGW_PREFIX: '/mingw64' }, { TERM_PROGRAM: 'mintty' }]) {
    assert.throws(() => validatePasswordTerminal('win32', false, env), /PowerShell/);
    assert.doesNotThrow(() => validatePasswordTerminal('win32', true, env));
    assert.doesNotThrow(() => validatePasswordTerminal('linux', false, env));
    assert.doesNotThrow(() => validatePasswordTerminal('darwin', false, env));
  }
  assert.doesNotThrow(() => validatePasswordTerminal('win32', false, {}));
  assert.doesNotThrow(() => validatePasswordTerminal('win32', false, { TERM: 'xterm-256color' }));
});

test('不安全终端的 login 不显示输入提示，也不调用认证', () => {
  const { spawnSync } = require('node:child_process');
  const { createTestEnv } = require('../scripts/isolated-env');
  const source = `const auth = require('./auth-service');
    auth.login = async () => { throw new Error('unexpected-authentication'); };
    const cli = require('./adapters/cli');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    cli.runCli(['login']);`;
  const result = spawnSync(process.execPath, ['-e', source], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: createTestEnv(process.env.MADMODEL_STATE_DIR, { MSYSTEM: 'MINGW64' }),
    input: 'sample\nsynthetic-password\n', encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  assert.strictEqual(result.status, 1, result.stderr);
  assert.match(result.stderr, /PowerShell/);
  assert.strictEqual(result.stdout, '');
  assert.doesNotMatch(result.stderr, /synthetic-password|unexpected-authentication/);
});

const ESC = '\u001b';
const CR = '\r';
const DEL = '\u007f';
const CTRL_C = '\u0003';

test('普通字符进缓冲,回车提交', () => {
  const r = applyPasswordKeys('', 'abc' + CR);
  assert.strictEqual(r.buffer, 'abc');
  assert.strictEqual(r.submit, true);
  assert.strictEqual(r.cancel, false);
});

test('粘贴整串(含结尾回车)不把回车混进密码', () => {
  const r = applyPasswordKeys('', 'P@ssw0rd!' + CR);
  assert.strictEqual(r.buffer, 'P@ssw0rd!');
  assert.strictEqual(r.submit, true);
});

test('P0 回归:方向键 ESC[A 不得写进密码', () => {
  const r = applyPasswordKeys('', 'ab' + ESC + '[A' + 'cd' + CR);
  assert.strictEqual(r.buffer, 'abcd', 'ESC[A 污染了密码');
  assert.strictEqual(r.submit, true);
});

test('各种转义序列都被整体吞掉', () => {
  for (const seq of [ESC + '[A', ESC + '[3~', ESC + 'OP', ESC + '[1;5D']) {
    const r = applyPasswordKeys('', 'ab' + seq + 'cd' + CR);
    assert.strictEqual(r.buffer, 'abcd', '序列 ' + JSON.stringify(seq) + ' 污染了密码');
  }
});

test('退格删一个字符并记一次回显', () => {
  const r = applyPasswordKeys('abc', DEL + CR);
  assert.strictEqual(r.buffer, 'ab');
  assert.strictEqual(r.backspaces, 1);
  assert.strictEqual(r.submit, true);
});

test('空缓冲上的退格不产生负回显', () => {
  const r = applyPasswordKeys('', DEL + DEL + CR);
  assert.strictEqual(r.buffer, '');
  assert.strictEqual(r.backspaces, 0);
});

test('Ctrl+C 取消,已输入的字符不提交', () => {
  const r = applyPasswordKeys('', 'ab' + CTRL_C);
  assert.strictEqual(r.cancel, true);
  assert.strictEqual(r.submit, false);
});

test('回车后的字符不再入缓冲(提交即止)', () => {
  const r = applyPasswordKeys('', 'ab' + CR + 'cdef');
  assert.strictEqual(r.buffer, 'ab');
  assert.strictEqual(r.submit, true);
});

test('多字节字符按一个字符计入', () => {
  const r = applyPasswordKeys('', '密码' + CR);
  assert.strictEqual(r.buffer, '密码');
  assert.strictEqual(r.submit, true);
});

// 模拟真实 stdin:把输入按给定的分片依次喂入,跨片保留 escState
function feed(pieces) {
  let buf = '';
  let esc = null;
  let submit = false;
  let cancel = false;
  for (const piece of pieces) {
    const r = applyPasswordKeys(buf, piece, esc);
    buf = r.buffer; esc = r.escState; submit = r.submit; cancel = r.cancel;
    if (submit || cancel) break;
  }
  return { buffer: buf, submit, cancel };
}

test('转义序列被拆到两个 chunk:仍不得污染密码', () => {
  // OS 的 read 分块点不可控:ESC 与 "[A" 可能分两次 data 事件到达。
  // 逐 chunk 独立处理时第二次的 "[A" 会被当普通字符(2026-09-21 实测
  // 得 "ab[Acd"),故状态必须跨 chunk 传递
  const r = feed(['ab' + ESC, '[Acd' + CR]);
  assert.strictEqual(r.buffer, 'abcd', 'ESC 与 [A 分片到达时污染了密码');
  assert.strictEqual(r.submit, true);
});

test('ESC 单独成片,随后才到 [ 与 A', () => {
  const r = feed(['ab', ESC, '[', 'A', 'cd' + CR]);
  assert.strictEqual(r.buffer, 'abcd', 'ESC 逐字符分片时污染了密码');
});

test('SS3 序列(ESC O P)跨三个 chunk', () => {
  const r = feed(['ab', ESC, 'O', 'P', 'cd' + CR]);
  assert.strictEqual(r.buffer, 'abcd', 'SS3 分片时污染了密码');
});

test('CSI 长序列([1;5D)跨多个 chunk', () => {
  const r = feed(['a', ESC, '[', '1', ';', '5', 'D', 'b' + CR]);
  assert.strictEqual(r.buffer, 'ab', '长 CSI 序列分片时污染了密码');
});

test('分片边界上正常字符不受影响', () => {
  const r = feed(['ab', 'cd', 'ef' + CR]);
  assert.strictEqual(r.buffer, 'abcdef');
  assert.strictEqual(r.submit, true);
});

test('ESC 后直接回车(用户按了 Esc 再回车)不吞掉回车', () => {
  const r = feed(['ab', ESC, CR]);
  assert.strictEqual(r.buffer, 'ab');
  assert.strictEqual(r.submit, true, '回车被 ESC 吞并逻辑吃掉');
});

test('孤立 ESC 后跟普通字符:不丢字符(按 Esc 再继续输入)', () => {
  // ESC 后既不是 [ 也不是 O,说明这不是转义序列(用户按了 Esc 想取消当前行,
  // 或 Alt+字母 组合)。此时该字符必须按普通输入处理,不能静默吞掉——
  // 吞掉的症状又是"密码不正确"(2026-09-21 审阅指出)
  const r = applyPasswordKeys('ab', ESC + 'cd' + CR);
  assert.strictEqual(r.buffer, 'abcd', 'ESC 后的 c 被静默吞掉');
  assert.strictEqual(r.submit, true);
});

test('孤立 ESC 跨 chunk 后跟普通字符:同样不丢', () => {
  const r = feed(['ab' + ESC, 'cd' + CR]);
  assert.strictEqual(r.buffer, 'abcd', '分片时 ESC 后的字符被吞掉');
});

test('已知序列引导符仍被正确吞并(回归)', () => {
  // 修"孤立 ESC 不丢字符"时不能把 [ 与 O 的序列识别弄坏
  assert.strictEqual(feed(['x', ESC + '[A', 'y' + CR]).buffer, 'xy');
  assert.strictEqual(feed(['x', ESC + 'OP', 'y' + CR]).buffer, 'xy');
  assert.strictEqual(feed(['x', ESC + '[1;5D', 'y' + CR]).buffer, 'xy');
});


test('CSI 标点类终止符(ESC[2@)不吞后续字符', () => {
  // ANSI 的 CSI final byte 是 0x40-0x7e,含 @ 等标点,不只是字母与 ~。
  // 只认字母/~/ 会把 @ 当参数继续吞,吃掉后续字符
  // (2026-09-22 审阅指出,实测 ESC[2@b 得 "a" 而非 "ab")
  const r = applyPasswordKeys('', 'a' + ESC + '[2@b' + CR);
  assert.strictEqual(r.buffer, 'ab', 'CSI 标点终止符后字符被吞');
});

test('emoji(补充平面)退格不破坏缓冲', () => {
  // 按 UTF-16 码元 slice(0,-1) 会把 emoji 拆成孤立代理对,缓冲损坏、
  // 密码必然认证失败(实测退格后只剩高位代理)。按码点删才对
  let r = applyPasswordKeys('', '😀' + CR);
  assert.strictEqual(r.buffer, '😀');
  assert.strictEqual(r.codePoints, 1, 'emoji 应算一个码点');
  r = applyPasswordKeys(r.buffer, DEL + CR);
  assert.strictEqual(r.buffer, '', 'emoji 退格后应清空,不能留半个代理对');
});

test('emoji 与 BMP 字符混排的码点计数', () => {
  const r = applyPasswordKeys('', '中a😀b' + CR);
  assert.strictEqual(r.codePoints, 4, '混排码点数应为 4');
  assert.strictEqual(r.buffer, '中a😀b');
});


test('Esc 后跟大写 O 再回车:回车不被当 SS3 尾字符吞掉', () => {
  // SS3 的尾字符也在 0x40-0x7e,但回车不在。若把回车当 SS3 尾字符吞掉,
  // 用户按 Esc 再打大写 O 再回车就提交不了、提示挂起
  // (2026-09-22 审阅实测:'ab',Esc,O,CR 得 submit=false)
  const r = applyPasswordKeys('', 'ab' + ESC + 'O' + CR);
  assert.strictEqual(r.submit, true, '回车被 SS3 逻辑吃掉,提示会挂起');
  assert.strictEqual(r.buffer, 'ab');
});

test('Esc O Ctrl+C:取消不被吞掉', () => {
  const r = applyPasswordKeys('', 'ab' + ESC + 'O' + CTRL_C);
  assert.strictEqual(r.cancel, true, 'Ctrl+C 被 SS3 逻辑吃掉');
});

test('真正的 SS3 序列(OP/OA)仍被完整吞并(回归)', () => {
  assert.strictEqual(applyPasswordKeys('', 'x' + ESC + 'OP' + 'y' + CR).buffer, 'xy');
  assert.strictEqual(applyPasswordKeys('', 'x' + ESC + 'OA' + 'y' + CR).buffer, 'xy');
});
