// core/stream-parser.js
// SSE 协议解析(纯逻辑):chunk 边界、UTF-8 解码、行解析、空 data 帧、[DONE]、
// 坏 JSON、单行长度限制。不访问网络、文件、token 或 HTTP response。
// [DONE] 在当前事件字段确定后进入终止态；EOF 调用 finish() 结算尾部。

'use strict';

class SseParser {
  constructor(lineLimit) {
    this.lineLimit = lineLimit;
    this.buffer = '';
    this.finished = false;
    this.eventName = '';
    this.lastDataValue = undefined;
    this.pendingDone = false;
    this.decoder = new TextDecoder('utf-8', { fatal: true });
  }

  invalid(message) {
    this.finished = true;
    this.pendingDone = false;
    this.buffer = '';
    return { type: 'invalid', message };
  }

  completeTerminal() {
    this.finished = true;
    this.pendingDone = false;
    this.buffer = '';
    return this.eventName === 'error'
      ? { type: 'error', value: { message: '上游报告流式错误' } }
      : { type: 'done' };
  }

  // 接受字符串或 UTF-8 字节(上游分块送达,解码跨 chunk 由 TextDecoder stream 模式保证)
  push(input) {
    if (this.finished) return [];
    let text;
    try {
      text = typeof input === 'string' ? input : this.decoder.decode(input, { stream: true });
    } catch {
      return [this.invalid('上游 SSE 含非法 UTF-8，已停止交付，避免替换字符改变正文或工具参数')];
    }
    this.buffer += text;
    const events = [];
    let end;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line, 'utf8') > this.lineLimit) {
        events.push(this.invalid(`上游 SSE 单行超过 ${this.lineLimit / 1024}KB`));
        break;
      }
      if (!line) {
        if (this.pendingDone) { events.push(this.completeTerminal()); break; }
        this.eventName = '';
        this.lastDataValue = undefined;
        continue;
      }
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
      // 兼容旧上游逐行 data、没有事件空行的形态。后续 data 行只能属于
      // 终止后的事件；此前 event 字段已经读完，不能交付终止后的内容。
      if (this.pendingDone) { events.push(this.completeTerminal()); break; }
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        // event:error 可在 data 后面，也可落在下一个网络块。只延后
        // 终止确认，普通工具参数仍逐行交付，不重新缓冲整个调用。
        this.pendingDone = true;
        this.lastDataValue = undefined;
        continue;
      }
      if (!data) continue;
      try {
        this.lastDataValue = JSON.parse(data);
        events.push({ type: this.eventName === 'error' ? 'error' : 'data', value: this.lastDataValue });
      } catch (error) {
        events.push(this.invalid(`上游 SSE 坏帧(len=${data.length}): JSON 无效`));
        break;
      }
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.lineLimit) {
      events.push(this.invalid(`上游 SSE 单行超过 ${this.lineLimit / 1024}KB 无换行`));
    }
    return events;
  }

  // EOF 是最后一行的边界；仍检查 decoder 缓存的尾字节，不能把截断的
  // UTF-8 吞掉后确认成功。没有 DONE 时返回普通尾部事件，由调用方报断流。
  finish() {
    if (this.finished) return [];
    try {
      this.buffer += this.decoder.decode();
    } catch {
      return [this.invalid('上游 SSE 结尾含不完整 UTF-8，已停止交付')];
    }
    const events = this.buffer ? this.push('\n') : [];
    if (this.finished) return events;
    if (this.pendingDone) events.push(this.completeTerminal());
    this.finished = true;
    this.buffer = '';
    return events;
  }
}

module.exports = { SseParser };
