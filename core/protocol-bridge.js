// core/protocol-bridge.js
// 协议翻译层：让只实现 OpenAI Chat Completions 的代理同时接受
// Anthropic Messages API(POST /v1/messages, Claude Code)与
// OpenAI Responses API(POST /v1/responses, Codex)。
//
// 设计：不复制业务编排。请求在 HTTP 层先翻译成 chat payload 交给
// core/proxy-service.js(继续享受 token 续期/预算预检/思考归一/工具补救)；
// 输出通过 wrapContext 包装的 ctx 翻译回原协议。业务层只认 chat，
// 完全不知道客户端说的是哪种协议。
//
// 纯逻辑(除 crypto.randomUUID 外无 I/O / 无环境变量)，便于单测。

'use strict';

const crypto = require('crypto');
const { normalizeReasoningDelta } = require('./thinking');

const RE_CHAT = /^\/(v1\/)?chat\/completions$/;
const RE_MESSAGES = /^\/v1\/messages(\?|$)/;
const RE_RESPONSES = /^\/v1\/responses(\?|$)/;

function detectProtocol(url) {
  const u = String(url || '').split('?')[0];
  if (RE_MESSAGES.test(u)) return 'anthropic';
  if (RE_RESPONSES.test(u)) return 'responses';
  if (RE_CHAT.test(u)) return 'chat';
  return null;
}

function newId(prefix) {
  return prefix + crypto.randomBytes(12).toString('hex');
}

function asString(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

// 把各种 content 形态(字符串 / text block / input_text / output_text)摊平成文本。
// 图片等非文本块丢弃：上游 chat 端点只接收文本，Claude Code 的图片能力
// 由上游模型自身决定，这里不做伪支持。
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (typeof b === 'string') { parts.push(b); continue; }
      if (!b || typeof b !== 'object') continue;
      if (typeof b.text === 'string') parts.push(b.text);
      else if (typeof b.input_text === 'string') parts.push(b.input_text);
      else if (typeof b.output_text === 'string') parts.push(b.output_text);
      else if (typeof b.content === 'string') parts.push(b.content);
    }
    return parts.join('\n');
  }
  return '';
}

function safeJsonArgs(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v ?? {}); } catch (e) { return '{}'; }
}

function parseArgs(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  try { const o = JSON.parse(asString(v) || '{}'); return (o && typeof o === 'object') ? o : {}; }
  catch (e) { return {}; }
}

// ---------------------------- 请求：协议 -> chat ----------------------------

function messagesFromAnthropic(body) {
  const out = [];
  const sys = body.system;
  const sysText = typeof sys === 'string' ? sys : textOf(sys);
  if (sysText) out.push({ role: 'system', content: sysText });

  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (typeof m.content === 'string') { out.push({ role, content: m.content }); continue; }
    const blocks = Array.isArray(m.content) ? m.content : [];
    let text = '';
    const uses = [];
    const results = [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') uses.push(b);
      else if (b.type === 'tool_result') results.push(b);
      else if (typeof b.text === 'string') text += b.text;
    }
    if (results.length) {
      for (const r of results) {
        out.push({
          role: 'tool',
          tool_call_id: asString(r.tool_use_id),
          content: textOf(r.content) || text,
        });
      }
      continue;
    }
    if (uses.length) {
      out.push({
        role: 'assistant',
        content: text || null,
        tool_calls: uses.map(u => ({
          id: asString(u.id) || newId('call_'),
          type: 'function',
          function: { name: asString(u.name), arguments: safeJsonArgs(u.input) },
        })),
      });
      continue;
    }
    out.push({ role, content: text });
  }
  return out;
}

function messagesFromResponses(body) {
  const out = [];
  if (typeof body.instructions === 'string' && body.instructions) {
    out.push({ role: 'system', content: body.instructions });
  }
  let items = body.input;
  if (typeof items === 'string') {
    items = [{ type: 'message', role: 'user', content: items }];
  }
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'function_call') {
      out.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: asString(it.call_id || it.id) || newId('call_'),
          type: 'function',
          function: { name: asString(it.name), arguments: safeJsonArgs(it.arguments) },
        }],
      });
      continue;
    }
    if (it.type === 'function_call_output') {
      out.push({
        role: 'tool',
        tool_call_id: asString(it.call_id),
        content: textOf(it.output),
      });
      continue;
    }
    const role = it.role === 'assistant' ? 'assistant'
      : it.role === 'system' ? 'system' : 'user';
    out.push({ role, content: textOf(it.content) });
  }
  return out;
}

function chatTools(tools, protocol) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const name = asString(t.name || t.function?.name);
    const description = asString(t.description ?? t.function?.description);
    const params = protocol === 'anthropic'
      ? (t.input_schema ?? t.function?.parameters)
      : (t.parameters ?? t.function?.parameters);
    if (!name) continue;
    out.push({
      type: 'function',
      function: { name, description, parameters: params || { type: 'object', properties: {} } },
    });
  }
  return out.length ? out : null;
}

function toChatPayload(body, protocol, defaultModel) {
  const messages = protocol === 'anthropic'
    ? messagesFromAnthropic(body) : messagesFromResponses(body);
  const payload = {
    model: asString(body.model) || asString(defaultModel),
    messages,
    stream: body.stream === true,
  };
  const maxTokens = protocol === 'anthropic' ? body.max_tokens : body.max_output_tokens;
  if (Number.isFinite(maxTokens) && maxTokens > 0) payload.max_tokens = maxTokens;
  if (Number.isFinite(body.temperature)) payload.temperature = body.temperature;
  if (Number.isFinite(body.top_p)) payload.top_p = body.top_p;
  const tools = chatTools(body.tools, protocol);
  if (tools) payload.tools = tools;
  if (protocol === 'anthropic') {
    if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
      payload.stop = body.stop_sequences.filter(s => typeof s === 'string');
    }
    const tc = body.tool_choice;
    if (tc && typeof tc === 'object') {
      if (tc.type === 'any') payload.tool_choice = 'required';
      else if (tc.type === 'tool' && tc.name) {
        payload.tool_choice = { type: 'function', function: { name: tc.name } };
      } else if (tc.type === 'none') payload.tool_choice = 'none';
    }
  }
  return payload;
}

// ---------------------------- 非流式：chat -> 协议 ----------------------------

function usageOf(out) {
  const u = out?.usage || {};
  return {
    prompt: Number(u.prompt_tokens) || 0,
    completion: Number(u.completion_tokens) || 0,
    total: Number(u.total_tokens) || 0,
  };
}

function stopReasonOf(finish, hasTools) {
  if (finish === 'tool_calls') return 'tool_use';
  if (finish === 'length') return 'max_tokens';
  if (hasTools) return 'tool_use';
  return 'end_turn';
}

function chatToAnthropic(out, req) {
  const msg = out?.choices?.[0]?.message || {};
  const content = [];
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const c of calls) {
    content.push({
      type: 'tool_use',
      id: asString(c.id) || newId('toolu_'),
      name: asString(c.function?.name),
      input: parseArgs(c.function?.arguments),
    });
  }
  const u = usageOf(out);
  return {
    id: newId('msg_'),
    type: 'message',
    role: 'assistant',
    model: asString(req.model || out?.model),
    content,
    stop_reason: stopReasonOf(out?.choices?.[0]?.finish_reason, calls.length > 0),
    stop_sequence: null,
    usage: { input_tokens: u.prompt, output_tokens: u.completion },
  };
}

function responseTextPart(text) {
  return { type: 'output_text', text, annotations: [] };
}

function responseMessageItem(text) {
  return {
    id: newId('msg_'), type: 'message', role: 'assistant', status: 'completed',
    content: [responseTextPart(text)],
  };
}

function responseCallItems(calls) {
  return calls.map(c => ({
    id: newId('fc_'), type: 'function_call', status: 'completed',
    call_id: asString(c.id), name: asString(c.function?.name),
    arguments: safeJsonArgs(c.function?.arguments),
  }));
}

function chatToResponses(out, req) {
  const msg = out?.choices?.[0]?.message || {};
  const text = typeof msg.content === 'string' ? msg.content : '';
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const output = [];
  if (text || !calls.length) output.push(responseMessageItem(text));
  output.push(...responseCallItems(calls));
  const u = usageOf(out);
  return {
    id: newId('resp_'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: asString(req.model || out?.model),
    output,
    output_text: text,
    usage: { input_tokens: u.prompt, output_tokens: u.completion, total_tokens: u.total },
  };
}

function errorBody(protocol, status, message, type) {
  const text = asString(message) || '代理请求失败';
  if (protocol === 'anthropic') {
    const kind = status === 401 || status === 403 ? 'authentication_error'
      : status === 429 ? 'rate_limit_error'
        : status === 400 || status === 413 ? 'invalid_request_error' : 'api_error';
    return { type: 'error', error: { type: kind, message: text } };
  }
  return { error: { message: text, type: asString(type) || 'proxy_error', code: status } };
}

// ---------------------------- 流式状态机 ----------------------------
// 三个方法都返回 [{event, data}]，交给 wrapContext 逐帧写出；不持有 res/ctx，
// 因此可以直接单测。

function ev(type, fields) {
  return { event: type, data: { ...fields, type } };
}

function createAnthropicStream(req) {
  const model = asString(req.model);
  const messageId = newId('msg_');
  let nextIndex = 0;
  let textIndex = -1;
  const tools = new Map();
  let usage = { prompt: 0, completion: 0 };
  let finishReason = null;
  let ended = false;

  return {
    start() {
      textIndex = nextIndex++;
      return [
        ev('message_start', { message: {
          id: messageId, type: 'message', role: 'assistant', model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        } }),
        ev('content_block_start', { index: textIndex, content_block: { type: 'text', text: '' } }),
        ev('ping', {}),
      ];
    },
    chunk(obj) {
      const out = [];
      if (obj?.usage) {
        usage = { prompt: Number(obj.usage.prompt_tokens) || 0,
          completion: Number(obj.usage.completion_tokens) || 0 };
      }
      const ch = obj?.choices?.[0] || {};
      const d = ch.delta || {};
      if (typeof d.content === 'string' && d.content) {
        out.push(ev('content_block_delta', {
          index: textIndex, delta: { type: 'text_delta', text: d.content },
        }));
      }
      // 上游思考内容(reasoning_content)不映射为 Anthropic thinking 块：
      // 那需要真实 signature，伪造会让 Claude Code 拒绝整段响应。
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const key = tc.index ?? 0;
          let t = tools.get(key);
          if (!t) {
            t = { index: nextIndex++, id: asString(tc.id) || newId('toolu_'),
              name: asString(tc.function?.name), args: '' };
            tools.set(key, t);
            out.push(ev('content_block_start', { index: t.index,
              content_block: { type: 'tool_use', id: t.id, name: t.name, input: {} } }));
          }
          const part = tc.function?.arguments;
          if (typeof part === 'string' && part) {
            t.args += part;
            out.push(ev('content_block_delta', { index: t.index,
              delta: { type: 'input_json_delta', partial_json: part } }));
          }
          if (tc.function?.name && !t.name) t.name = tc.function.name;
        }
      }
      if (ch.finish_reason) finishReason = ch.finish_reason;
      return out;
    },
    finish() {
      if (ended) return [];
      ended = true;
      const out = [];
      if (textIndex >= 0) out.push(ev('content_block_stop', { index: textIndex }));
      for (const t of tools.values()) out.push(ev('content_block_stop', { index: t.index }));
      out.push(ev('message_delta', {
        delta: { stop_reason: stopReasonOf(finishReason, tools.size > 0), stop_sequence: null },
        usage: { output_tokens: usage.completion },
      }));
      out.push(ev('message_stop', {}));
      return out;
    },
    error(message) {
      return [ev('error', { error: { type: 'api_error', message: asString(message) } })];
    },
  };
}

function createResponsesStream(req) {
  const base = {
    id: newId('resp_'), object: 'response',
    created_at: Math.floor(Date.now() / 1000), model: asString(req.model),
  };
  const textItemId = newId('msg_');
  let usage = { prompt: 0, completion: 0, total: 0 };
  let text = '';
  let textClosed = false;
  const calls = new Map();
  let nextOutputIndex = 1;
  let ended = false;

  const response = (status, extra = {}) => ({ ...base, status, ...extra });
  const messageItem = () => ({
    id: textItemId, type: 'message', role: 'assistant', status: 'completed',
    content: [responseTextPart(text)],
  });
  function closeText() {
    if (textClosed) return [];
    textClosed = true;
    return [
      ev('response.output_text.done', { item_id: textItemId, output_index: 0,
        content_index: 0, text }),
      ev('response.content_part.done', { item_id: textItemId, output_index: 0,
        content_index: 0, part: responseTextPart(text) }),
      ev('response.output_item.done', { output_index: 0, item: messageItem() }),
    ];
  }

  return {
    start() {
      return [
        ev('response.created', { response: response('in_progress', { output: [] }) }),
        ev('response.in_progress', { response: response('in_progress', { output: [] }) }),
        ev('response.output_item.added', { output_index: 0, item: {
          id: textItemId, type: 'message', role: 'assistant', status: 'in_progress', content: [],
        } }),
        ev('response.content_part.added', { item_id: textItemId, output_index: 0,
          content_index: 0, part: responseTextPart('') }),
      ];
    },
    chunk(obj) {
      const out = [];
      if (obj?.usage) {
        usage = {
          prompt: Number(obj.usage.prompt_tokens) || 0,
          completion: Number(obj.usage.completion_tokens) || 0,
          total: Number(obj.usage.total_tokens) || 0,
        };
      }
      const ch = obj?.choices?.[0] || {};
      const d = ch.delta || {};
      if (typeof d.content === 'string' && d.content) {
        text += d.content;
        out.push(ev('response.output_text.delta', { item_id: textItemId,
          output_index: 0, content_index: 0, delta: d.content }));
      }
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) {
        out.push(...closeText());
        for (const tc of d.tool_calls) {
          const key = tc.index ?? 0;
          let t = calls.get(key);
          if (!t) {
            t = { id: newId('fc_'), callId: asString(tc.id) || newId('call_'),
              name: asString(tc.function?.name), args: '', outputIndex: nextOutputIndex++ };
            calls.set(key, t);
            out.push(ev('response.output_item.added', { output_index: t.outputIndex, item: {
              id: t.id, type: 'function_call', status: 'in_progress',
              call_id: t.callId, name: t.name, arguments: '',
            } }));
          }
          const part = tc.function?.arguments;
          if (typeof part === 'string' && part) {
            t.args += part;
            out.push(ev('response.function_call_arguments.delta', {
              item_id: t.id, output_index: t.outputIndex, delta: part,
            }));
          }
          if (tc.function?.name && !t.name) t.name = tc.function.name;
        }
      }
      return out;
    },
    finish() {
      if (ended) return [];
      ended = true;
      const out = closeText();
      const output = [];
      if (text || !calls.size) output.push(messageItem());
      for (const t of calls.values()) {
        out.push(ev('response.function_call_arguments.done', {
          item_id: t.id, output_index: t.outputIndex, arguments: t.args,
        }));
        const item = {
          id: t.id, type: 'function_call', status: 'completed',
          call_id: t.callId, name: t.name, arguments: t.args,
        };
        output.push(item);
        out.push(ev('response.output_item.done', { output_index: t.outputIndex, item }));
      }
      out.push(ev('response.completed', { response: response('completed', {
        output, output_text: text,
        usage: { input_tokens: usage.prompt, output_tokens: usage.completion,
          total_tokens: usage.total },
      }) }));
      return out;
    },
    error(message) {
      return [ev('response.failed', { response: response('failed', {
        error: { message: asString(message), code: 'proxy_error' },
      }) })];
    },
  };
}

// ---------------------------- ctx 适配层 ----------------------------
// 继承原 ctx 的原型：未覆盖的字段/方法(req/res/size/abortController/log 等)
// 全部透传；业务层看到的仍是一个"普通 ctx"。
function wrapContext(ctx, protocol, original, chatRawBody) {
  const translator = protocol === 'anthropic'
    ? createAnthropicStream(original) : createResponsesStream(original);
  let started = false;
  let thinkingFields = null;
  const wrapped = Object.create(ctx);

  function emitAll(list) {
    for (const e of list || []) {
      ctx.writeSseLine(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
    }
  }
  function begin() {
    if (started) return;
    started = true;
    ctx.ensureSseHeaders();
    emitAll(translator.start());
  }

  wrapped.rawBody = chatRawBody;
  wrapped.size = chatRawBody.length;
  wrapped.ensureSseHeaders = () => begin();
  wrapped.setThinkingFields = fields => {
    thinkingFields = fields;
    ctx.setThinkingFields(fields);
  };
  wrapped.writeSseChunk = obj => {
    // 原 ctx.writeSseChunk 承担思考字段归一；协议分支不走它，这里补上，
    // 否则上游用 qwen 方言吐思考时下游会拿到未归一化的裸字段。
    normalizeReasoningDelta(obj, thinkingFields);
    begin();
    emitAll(translator.chunk(obj));
  };
  wrapped.writeSseLine = line => {
    begin();
    const text = String(line);
    if (text.includes('[DONE]')) return emitAll(translator.finish());
    const m = /^data:\s*(\{[\s\S]*\})\s*$/.exec(text.trim());
    if (m) {
      try { emitAll(translator.chunk(JSON.parse(m[1]))); } catch (e) { /* 忽略非 JSON 帧 */ }
    }
  };
  wrapped.sendJson = (status, body, headers) => {
    if (status === 200 && body && body.object === 'chat.completion') {
      const converted = protocol === 'anthropic'
        ? chatToAnthropic(body, original) : chatToResponses(body, original);
      return ctx.sendJson(status, converted, headers);
    }
    return ctx.sendJson(status, body, headers);
  };
  wrapped.sendError = (status, message, type, headers) => {
    if (ctx.headersSent() || ctx.sseHeadersSent()) {
      begin();
      emitAll(translator.error(message));
      ctx.endResponse();
      return;
    }
    return ctx.sendJson(status, errorBody(protocol, status, message, type), headers);
  };
  return wrapped;
}

module.exports = {
  detectProtocol, toChatPayload, chatToAnthropic, chatToResponses, errorBody,
  createAnthropicStream, createResponsesStream, wrapContext, textOf,
};
