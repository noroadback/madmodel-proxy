'use strict';
const { parentPort } = require('worker_threads');
const { getTokenizer } = require('./tokenizer');
// 只收集计数所需文本，不接触凭据、图片、网络或日志。
if (parentPort) {
  const tokenizer = getTokenizer();
  parentPort.on('message', ({ id, work }) => {
    try {
      let tokens = work.overhead;
      for (const text of work.parts) tokens += tokenizer.countText(text);
      parentPort.postMessage({ id, exact: true, tokens, mode: 'worker' });
    } catch (error) {
      parentPort.postMessage({ id, exact: false, reason: error.code === 'TOKENIZER_PIECE_LIMIT' ? 'piece-limit' : 'worker-error' });
    }
  });
}
