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
    this.eventName = '';
    this.lastDataValue = undefined;
    this.decoder = new TextDecoder('utf-8', { fatal: true });
  }

  // 接受字符串或 UTF-8 字节(上游分块送达,解码跨 chunk 由 TextDecoder stream 模式保证)
  push(input) {
    if (this.finished) return [];
    let text;
    try {
      text = typeof input === 'string' ? input : this.decoder.decode(input, { stream: true });
    } catch {
      this.finished = true;
      this.buffer = '';
      return [{ type: 'invalid', message: '上游 SSE 含非法 UTF-8，已停止交付，避免替换字符改变正文或工具参数' }];
    }
    this.buffer += text;
    const events = [];
    let end;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line, 'utf8') > this.lineLimit) {
        events.push({ type: 'invalid', message: `上游 SSE 单行超过 ${this.lineLimit / 1024}KB` });
        this.finished = true;
        this.buffer = '';
        break;
      }
      if (!line) { this.eventName = ''; this.lastDataValue = undefined; continue; }
      if (line.startsWith('event:')) {
        this.eventName = line.slice(6).trim();
        // SSE 允许 event 字段位于 data 之后。普通分片已实时交付时，补产
        // 错误事件即可阻止调用方冲刷成功收尾，不必推迟每个正常 data 行。
        if (this.eventName === 'error' && this.lastDataValue !== undefined) {
          events.push({ type: 'error', value: this.lastDataValue });
        }
        continue;
      }
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        if (this.eventName === 'error') {
          events.push({ type: 'error', value: { message: '上游报告流式错误' } });
          continue;
        }
        this.finished = true;
        events.push({ type: 'done' });
        this.buffer = '';
        break;
      }
      if (!data) continue;
      try {
        this.lastDataValue = JSON.parse(data);
        events.push({ type: this.eventName === 'error' ? 'error' : 'data', value: this.lastDataValue });
      } catch (error) {
        events.push({
          type: 'invalid',
          message: `上游 SSE 坏帧(len=${data.length}): JSON 无效`,
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
