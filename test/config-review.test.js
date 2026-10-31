'use strict';
require('../scripts/isolated-env').isolate();
const test = require('node:test');
const assert = require('node:assert/strict');
const { compileToolStripRules, shouldStripTools } = require('../core/tool-strip-rules');
const { normalizePayload } = require('../core/payload');
const filename = require.resolve('../config');
function withEnv(key, value, fn) {
  const previous = process.env[key], cached = require.cache[filename];
  try {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    delete require.cache[filename];
    return fn();
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    delete require.cache[filename];
    if (cached) require.cache[filename] = cached;
  }
}

test('所有可配毫秒时限拒绝溢出、负数和小数，接受 Node 最大值', () => {
  const keys = ['HEADER', 'IDLE', 'STREAM_TOTAL', 'NONSTREAM_TOTAL', 'REFRESH_AHEAD',
    'NO_TOKEN_WAIT', 'MAX_SLEEP', 'KEEPALIVE', 'RETRY_WAIT'].map(s => `PROXY_${s}_MS`);
  for (const key of keys) {
    for (const value of ['2147483648', '1e20', '-1', '0', '1.5', 'NaN']) {
      withEnv(key, value, () => assert.throws(() => require('../config'), { code: 'INVALID_TIMEOUT_CONFIG' }));
    }
    withEnv(key, '2147483647', () => assert.ok(require('../config')));
    withEnv(key, ' ', () => assert.ok(require('../config')));
  }
});

test('默认工具剥离仅命中已知 R1，空配置禁用，正则逗号与转义可用', () => {
  assert.equal(shouldStripTools('DeepSeek-R1-W8A8'), true);
  for (const id of ['new-R1-tool-model', 'r1', 'DeepSeek-V4.1-Flash']) assert.equal(shouldStripTools(id), false);
  assert.equal(shouldStripTools('DeepSeek-R1-W8A8', compileToolStripRules('')), false);
  const rules = compileToolStripRules(' old-*, /^a{1,3}[,/]b$/g, /^x\\/y$/i ');
  for (let n = 0; n < 2; n++) for (const id of ['OLD-model', 'aa,b', 'a/b', 'X/y']) {
    assert.equal(shouldStripTools(id, rules), true, id);
  }
  for (const bad of ['/R1', '/[abc/', '/x/zz', '/(/', '/a/i/j']) {
    assert.throws(() => compileToolStripRules(bad), { code: 'INVALID_TOOL_RULE' });
  }
});

test('规则只在配置加载时读取，运行时环境变化不会改变请求', () => {
  const cfg = withEnv('PROXY_STRIP_TOOLS_FOR', 'only-this', () => require('../config'));
  withEnv('PROXY_STRIP_TOOLS_FOR', '*', () => {
    const tools = [{ type: 'function', function: { name: 'read' } }];
    const body = { model: 'new-R1-tools', tools };
    normalizePayload(body, body.model, null, undefined, cfg.toolStripRules);
    assert.deepEqual(body.tools, tools);
    const match = { model: 'only-this', tools };
    normalizePayload(match, match.model, null, undefined, cfg.toolStripRules);
    assert.equal(match.tools, undefined);
  });
  withEnv('PROXY_STRIP_TOOLS_FOR', '/broken', () => {
    assert.throws(() => require('../config'), { code: 'INVALID_TOOL_RULE' });
  });
});
