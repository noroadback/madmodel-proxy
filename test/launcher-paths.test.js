'use strict';
require('../scripts/isolated-env').isolate();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createTestEnv } = require('../scripts/isolated-env');

test('Windows launcher 支持含空格与感叹号的安装及自定义状态路径',
  { skip: process.platform !== 'win32', timeout: 15000 }, () => {
    const root = path.join(process.env.MADMODEL_STATE_DIR, 'install ! path');
    const state = path.join(process.env.MADMODEL_STATE_DIR, 'state ! custom');
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'core'));
    fs.copyFileSync(path.join(__dirname, '..', 'start.cmd'), path.join(root, 'start.cmd'));
    fs.writeFileSync(path.join(root, 'scripts', 'shortcut-state.js'),
      `require(${JSON.stringify(require.resolve('../scripts/shortcut-state'))});`);
    fs.writeFileSync(path.join(root, 'core', 'proxy-status.js'), 'process.exit(1);');
    fs.writeFileSync(path.join(root, 'network-choice.js'),
      "console.log('SET https://example.invalid/test!path');");
    fs.writeFileSync(path.join(root, 'dashboard.js'),
      "require('fs').writeFileSync(require('path').join(process.env.MADMODEL_STATE_DIR, 'launched.json'), JSON.stringify({cwd: __dirname, upstream: process.env.PROXY_UPSTREAM}));");
    const env = createTestEnv(state);
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = path.dirname(process.execPath) + path.delimiter + (env[pathKey] || '');
    const remember = spawnSync(process.execPath, [require.resolve('../scripts/shortcut-state'), 'remember'], { env });
    assert.equal(remember.status, 0);
    assert.ok(fs.existsSync(path.join(state, 'shortcut-created')));
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start.cmd campus'],
      { cwd: root, env, input: '\r\n', encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Create a desktop shortcut/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'launched.json'), 'utf8')),
      { cwd: root, upstream: 'https://example.invalid/test!path' });
  });
