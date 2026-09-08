// core/completion-aggregator.js
// 非流式聚合:把上游 SSE delta 流拼回完整 chat.completion 对象(纯数据变换)。
// 不依赖 HTTP、fetch、AbortController、环境变量或文件系统。

'use strict';

function createAggregator(model = '') {
  return {
    id: '', model,
    content: '', reasoning: '',
    toolCalls: {}, // index → {id, type, function:{name, arguments}}
    finish: null, usage: null, created: 0,
    feed(obj) {
      if (obj.id) this.id = obj.id;
      if (obj.created) this.created = obj.created;
      if (obj.model) this.model = obj.model;
      if (obj.usage) this.usage = obj.usage;
      const ch = obj.choices?.[0];
      if (!ch) return;
      if (ch.finish_reason) this.finish = ch.finish_reason;
      const d = ch.delta || {};
      if (typeof d.content === 'string') this.content += d.content;
      if (typeof d.reasoning_content === 'string') this.reasoning += d.reasoning_content;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index != null ? tc.index : 0;
          if (!this.toolCalls[i]) this.toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) this.toolCalls[i].id = tc.id;
          if (tc.function) {
            if (tc.function.name) this.toolCalls[i].function.name += tc.function.name;
            if (tc.function.arguments) this.toolCalls[i].function.arguments += tc.function.arguments;
          }
        }
      }
    },
    result() {
      const message = { role: 'assistant', content: this.content || null };
      if (this.reasoning) message.reasoning_content = this.reasoning;
      const toolList = Object.keys(this.toolCalls).sort((a, b) => Number(a) - Number(b))
        .map(k => this.toolCalls[k]).filter(tc => tc.id || tc.function.name);
      if (toolList.length) message.tool_calls = toolList;
      return {
        id: this.id || `chatcmpl-proxy-${Date.now()}`,
        object: 'chat.completion',
        created: this.created || Math.floor(Date.now() / 1000),
        model: this.model,
        choices: [{ index: 0, message, finish_reason: this.finish || 'stop' }],
        usage: this.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    },
  };
}

module.exports = { createAggregator };
