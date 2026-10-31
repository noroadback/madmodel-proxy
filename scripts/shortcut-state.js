// start.cmd 通过退出码访问统一状态目录，不把路径交给 cmd 再次展开。
'use strict';
const fs = require('fs');
const path = require('path');
const { STATE_DIR } = require('../platform/paths');
const { atomicWrite } = require('../platform/file-store');
const marker = path.join(STATE_DIR, 'shortcut-created');
if (process.argv[2] === 'check') process.exitCode = fs.existsSync(marker) ? 0 : 1;
else if (process.argv[2] === 'remember') {
  fs.mkdirSync(STATE_DIR, { recursive: true }); atomicWrite(marker, '');
} else process.exitCode = 2;
