'use strict';

const fs = require('node:fs');
const path = require('node:path');
const LIMIT = 1024 * 1024;

// 只接收已经脱敏的结构，失败不能影响请求收尾。最多保留两份约 1 MiB。
function appendDiagnostic(tokenFile, record) {
  try {
    const file = path.join(path.dirname(tokenFile), 'failure-diagnostics.jsonl');
    const line = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(line) > 32768) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let size = 0;
    try { size = fs.statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (size + Buffer.byteLength(line) > LIMIT) {
      fs.copyFileSync(file, file + '.previous');
      fs.writeFileSync(file, '', { mode: 0o600 });
    }
    fs.appendFileSync(file, line, { mode: 0o600 });
    return true;
  } catch { return false; }
}

module.exports = { appendDiagnostic };
