// release-check.js
// 开源发布前的本地仓库自检:文件齐全、敏感文件未被 Git 跟踪、Node 版本满足
// engines 要求、测试入口存在。只读本地仓库,不访问任何网络服务。
// 用法: node scripts/release-check.js(或 npm run check:release)

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createHash } = require('crypto');

const root = path.resolve(__dirname, '..');
const failures = [];
const worktreeOnly = process.argv.includes('--worktree');

function fail(message) {
  failures.push(message);
  console.error(`✗ ${message}`);
}

function ok(message) {
  console.log(`✓ ${message}`);
}

// 1) 关键文件存在
for (const file of ['LICENSE', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md',
  'THIRD-PARTY-NOTICES.md', 'CHANGELOG.md']) {
  if (fs.existsSync(path.join(root, file))) ok(`${file} 存在`);
  else fail(`${file} 缺失`);
}

// 2) package.json 完整性
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const field of ['name', 'version', 'description', 'license']) {
  if (pkg[field]) ok(`package.json: ${field} 已设置`);
  else fail(`package.json: ${field} 缺失`);
}

// 2b) package.json 的 version 必须等于 CHANGELOG 最新版本标题
// 只检查 version 非空抓不到"改代码忘 bump":那种情况下 packag.json 停在旧值,
// 发布后 update-check 与 GitHub releases/latest 永久不匹配,用户每次开窗口都
// 被告知"有新版本"且 pull 再多次也不消失(2026-09-21 实测的正是这一形态)
try {
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const m = /^##\s+(\d+\.\d+\.\d+)\s*$/m.exec(changelog);
  if (!m) {
    fail('CHANGELOG.md 找不到形如 "## X.Y.Z" 的版本标题');
  } else if (m[1] !== pkg.version) {
    fail(`版本号不一致: package.json=${pkg.version}, CHANGELOG 最新=${m[1]}`);
  } else {
    ok(`版本号一致: package.json 与 CHANGELOG 均为 ${pkg.version}`);
  }
} catch (e) {
  fail('无法读取 CHANGELOG.md');
}

// 3) 敏感文件不在 Git 跟踪列表(误提交即拒绝发布)
const SENSITIVE = ['token.json', 'creds.json', 'api-key', 'api-keys', 'service.env', 'last-failed-request.json',
  'watch.lock', 'auth.lock', 'frames.log', 'upstream-frames.log', '_proxy-run.log'];
let tracked = null;
try {
  tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean);
} catch (e) {
  fail('无法运行 git ls-files(不在 Git 仓库中?)');
}
// 查询失败时不得打"未被跟踪":那只说明没查成,不代表没被跟踪——恰在最该
// 谨慎时给出最强的安心信号,比不检查更坏
if (tracked) {
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const unpublished = untracked.filter(f => /\.(js|json|md|cmd|ya?ml)$/.test(f));
  if (unpublished.length) {
    const message = `新增文件尚未纳入 Git（${unpublished.length} 个）: ${unpublished.join(', ')}`;
    if (worktreeOnly) console.warn(`! ${message}`);
    else fail(message);
  }
  const baseNames = new Set(tracked.map(f => path.basename(f)));
  for (const name of SENSITIVE) {
    if (baseNames.has(name)) fail(`敏感文件被 Git 跟踪: ${name}`);
    else ok(`敏感文件未被跟踪: ${name}`);
  }
  if (tracked.some(f => f.includes('.madmodel-proxy') || f.includes('.dsh-madmodel'))) {
    fail('状态目录(.madmodel-proxy/ 或旧名 .dsh-madmodel/)下有文件被跟踪');
  } else {
    ok('状态目录(.madmodel-proxy/ 及旧名 .dsh-madmodel/)未被跟踪');
  }
  if (tracked.some(f => /\.lock\.holders\//.test(f))) fail('PID 锁竞争目录被 Git 跟踪');
}

// 校验随仓库分发的第三方文件，避免意外改写或截断。
for (const [file, expected] of [
  ['sm2.js', '1ac60195da5994572e48d77f5e5aa6b5c0e98939023f62f0e8a2739b6df78791'],
  ['vendor/deepseek-tokenizer.json', '621ac2e32d0dba658404412318818aaa8ce8cda492e59830109d8da6b517fb41'],
]) {
  try {
    const hash = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    if (hash !== expected) fail(`第三方文件校验不一致: ${file}`);
    else ok(`第三方文件校验通过: ${file}`);
  } catch (e) { fail(`无法读取第三方文件: ${file}`); }
}

// 4) 当前 Node 版本满足 engines.node
const match = /^>=\s*(\d+)\.(\d+)/.exec(pkg.engines?.node || '');
if (!match) {
  fail(`无法解析 engines.node: ${pkg.engines?.node}`);
} else {
  const [needMajor, needMinor] = [Number(match[1]), Number(match[2])];
  const [curMajor, curMinor] = process.versions.node.split('.').map(Number);
  if (curMajor > needMajor || (curMajor === needMajor && curMinor >= needMinor)) {
    ok(`Node ${process.versions.node} 满足 engines.node ${pkg.engines.node}`);
  } else {
    fail(`Node ${process.versions.node} 不满足 engines.node ${pkg.engines.node}`);
  }
}

// 5) .gitignore 覆盖防御性兜底
const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
for (const rule of ['node_modules/', 'token.json', 'creds.json', 'api-key',
  'last-failed-request.json', '*.tmp', '*.lock.holders/']) {
  if (gitignore.includes(rule)) ok(`.gitignore 覆盖: ${rule}`);
  else fail(`.gitignore 缺少规则: ${rule}`);
}

console.log(failures.length
  ? `\n发布检查未通过: ${failures.length} 项问题(见上)`
  : worktreeOnly ? '\n工作区检查通过；尚未验证提交内容，请在暂存新增文件后运行默认发布检查。'
    : '\n本地发布检查通过；请另行确认测试结果、暂存区和 Git 历史。');
process.exit(failures.length ? 1 : 0);
