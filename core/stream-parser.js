// core/stream-parser.js
// SSE 协议解析(纯逻辑):chunk 边界、UTF-8 解码、行解析、空 data 帧、[DONE]、
// 坏 JSON、单行长度限制。不访问网络、文件、token 或 HTTP response。
// [DONE] 后进入终止态,不再产生事件。

'use strict';

class SseParser {
  constructor(lineLimit) {
    this.lineLimit = lineLimit;
    this.buffer = '';
    this.finished = false;
    this.decoder = new TextDecoder();
  }

  // 接受字符串或 UTF-8 字节(上游分块送达,解码跨 chunk 由 TextDecoder stream 模式保证)
  push(input) {
    const text = typeof input === 'string' ? input : this.decoder.decode(input, { stream: true });
    if (this.finished) return [];
    this.buffer += text;
    const events = [];
    let end;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        this.finished = true;
        events.push({ type: 'done' });
        this.buffer = '';
        break;
      }
      if (!data) continue;
      try {
        events.push({ type: 'data', value: JSON.parse(data) });
      } catch (error) {
        events.push({
          type: 'invalid',
          message: `上游 SSE 坏帧(len=${data.length}): ${JSON.stringify(data.slice(0, 40))}`,
        });
      }
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.lineLimit) {
      events.push({ type: 'invalid', message: `上游 SSE 单行超过 ${this.lineLimit / 1024}KB 无换行` });
      this.buffer = '';
    }
    return events;
  }
}

module.exports = { SseParser };
