// test/paths.test.js — 状态目录迁移(旧 .dsh-madmodel → .madmodel-proxy)纯函数行为。
// 经 MADMODEL_STATE_DIR 重定向隔离,不触碰真实凭据;直接测 migrateStateDir
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须在 require paths 之前设重定向:paths 在 require 时执行一次自动迁移,
// 不设的话本测试会对真实状态目录产生副作用
process.env.MADMODEL_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-state-'));
const { migrateStateDir } = require('../platform/paths');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mm-mig-'));
const w = (dir, name, content) => fs.writeFileSync(path.join(dir, name), content);

test('迁移: 凭据文件逐个迁移,锁文件与未知文件不迁', () => {
  const oldDir = tmp(), newDir = tmp();
  w(oldDir, 'creds.json', 'C');
  w(oldDir, 'token.json', 'T');
  w(oldDir, 'watch.lock', 'L');
  w(oldDir, 'shortcut-created', 'S');
  const moved = migrateStateDir(oldDir, newDir);
  assert.strictEqual(moved, 2);
  assert.strictEqual(fs.readFileSync(path.join(newDir, 'creds.json'), 'utf8'), 'C');
  assert.strictEqual(fs.readFileSync(path.join(newDir, 'token.json'), 'utf8'), 'T');
  assert.ok(!fs.existsSync(path.join(newDir, 'watch.lock')));
  // 旧目录残留未迁文件,不删除
  assert.ok(fs.existsSync(path.join(oldDir, 'watch.lock')));
});

test('迁移: 迁空后旧目录被删除', () => {
  const oldDir = tmp(), newDir = tmp();
  w(oldDir, 'token.json', 'T');
  migrateStateDir(oldDir, newDir);
  assert.ok(!fs.existsSync(oldDir));
});

test('迁移: 幂等——新目录已有文件不覆盖,旧目录无文件是空操作', () => {
  const oldDir = tmp(), newDir = tmp();
  w(oldDir, 'token.json', 'OLD');
  w(newDir, 'token.json', 'NEW');
  const moved = migrateStateDir(oldDir, newDir);
  assert.strictEqual(moved, 0);
  assert.strictEqual(fs.readFileSync(path.join(newDir, 'token.json'), 'utf8'), 'NEW');
  assert.ok(fs.existsSync(path.join(oldDir, 'token.json')));
});

test('迁移: 旧目录不存在 → 空操作不抛错', () => {
  const oldDir = path.join(os.tmpdir(), 'mm-not-exist-' + Date.now());
  const newDir = tmp();
  assert.strictEqual(migrateStateDir(oldDir, newDir), 0);
});

test('迁移: 新目录不存在时自动创建', () => {
  const oldDir = tmp();
  const newDir = path.join(os.tmpdir(), 'mm-new-' + Date.now());
  w(oldDir, 'creds.json', 'C');
  const moved = migrateStateDir(oldDir, newDir);
  assert.strictEqual(moved, 1);
  assert.ok(fs.existsSync(path.join(newDir, 'creds.json')));
});
