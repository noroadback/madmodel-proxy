// release-check.js
// 开源发布前的本地仓库自检:文件齐全、敏感文件未被 Git 跟踪、Node 版本满足
// engines 要求、测试入口存在。只读本地仓库,不访问任何网络服务。
// 用法: node scripts/release-check.js(或 npm run check:release)

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const failures = [];

function fail(message) {
  failures.push(message);
  console.error(`✗ ${message}`);
}

function ok(message) {
  console.log(`✓ ${message}`);
}

// 1) 关键文件存在
for (const file of ['LICENSE', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md']) {
  if (fs.existsSync(path.join(root, file))) ok(`${file} 存在`);
  else fail(`${file} 缺失`);
}

// 2) package.json 完整性
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const field of ['name', 'version', 'description', 'license']) {
  if (pkg[field]) ok(`package.json: ${field} 已设置`);
  else fail(`package.json: ${field} 缺失`);
}
if (pkg.scripts?.test) ok('package.json: test 脚本存在');
else fail('package.json: test 脚本缺失');

// 3) 敏感文件不在 Git 跟踪列表(误提交即拒绝发布)
const SENSITIVE = ['token.json', 'creds.json', 'api-key', 'last-failed-request.json',
  'watch.lock', 'auth.lock'];
let tracked = [];
try {
  tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean);
} catch (e) {
  fail('无法运行 git ls-files(不在 Git 仓库中?)');
}
const baseNames = new Set(tracked.map(f => path.basename(f)));
for (const name of SENSITIVE) {
  if (baseNames.has(name)) fail(`敏感文件被 Git 跟踪: ${name}`);
  else ok(`敏感文件未被跟踪: ${name}`);
}
if (tracked.some(f => f.includes('.dsh-madmodel'))) {
  fail('状态目录 .dsh-madmodel/ 下有文件被跟踪');
} else {
  ok('状态目录 .dsh-madmodel/ 未被跟踪');
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
  'last-failed-request.json', '*.tmp']) {
  if (gitignore.includes(rule)) ok(`.gitignore 覆盖: ${rule}`);
  else fail(`.gitignore 缺少规则: ${rule}`);
}

console.log(failures.length
  ? `\n发布检查未通过: ${failures.length} 项问题(见上)`
  : '\n发布检查全部通过');
process.exit(failures.length ? 1 : 0);
