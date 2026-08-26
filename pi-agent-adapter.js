/* ============================================================
 * pi-agent-adapter.js
 * 参考适配器：把 pi-agent 的 AgentEvent 流转成 AgentChat 组件的消息。
 *
 * 对应「路径 A（进程内直连）」：自己软件里直接调 runAgentLoop，
 * 把它的 emit 回调接到本适配器，再喂给 AgentChat.enqueue。
 *
 * 用法（伪代码）：
 *   const chat = new AgentChat(listEl, opts);
 *   const emit = makePiAgentAdapter(chat);
 *   await runAgentLoop(prompts, ctx, config, emit, signal, streamFn);
 *
 * 约定：
 *   - 稳定 id：用户 u-<n>；assistant 内容块 a-<n>#<contentIndex>；工具卡 tc-<toolCallId>
 *   - 工具参数流式：toolcall_delta 累加 buffer，展示「部分 + …」占位，toolcall_end 换完整对象
 *   - 执行中部分结果：tool_execution_update 携带 resultText（快照）
 *   - 结构化 details：tool_execution_end 时直接拼进 resultText（方案 B）
 *   - stopReason:"length"：给最后一块 text 打 truncated，渲染「输出已截断」
 * ============================================================ */

(function (global) {
  'use strict';

  var toolCardId = function (toolCallId) { return 'tc-' + toolCallId; };

  var now = function () {
    return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  };

  // content（字符串或块数组）→ 纯文本（图片单独用 contentToImages 提取）
  function contentToText(content) {
    if (typeof content === 'string') return content;
    var parts = [];
    (content || []).forEach(function (block) {
      if (block && block.type === 'text') parts.push(block.text);
    });
    return parts.join('\n');
  }

  // content 里的图片块 → images 数组（供组件渲染 <img>）
  function contentToImages(content) {
    if (typeof content === 'string' || !content) return null;
    var imgs = [];
    content.forEach(function (block) {
      if (block && block.type === 'image') imgs.push({ data: block.data, mimeType: block.mimeType });
    });
    return imgs.length ? imgs : null;
  }

  function stringifyDetails(details) {
    if (details == null) return '';
    try {
      var json = JSON.stringify(details, null, 2);
      return json === '{}' || json === 'null' ? '' : json;
    } catch (e) {
      return '';
    }
  }

  function makePiAgentAdapter(chat) {
    var seq = 0;
    function nextId(prefix) { return prefix + '-' + (++seq); }

    // 当前 assistant 消息的内容块 id 前缀
    var assistantPrefix = '';
    // 工具参数流式 buffer：toolCallId → JSON 字符串
    var argBuffers = {};
    // 工具最终参数缓存：tool_execution_end 事件本身不带 args，从这里回填
    var lastArgs = {};
    // 本轮开始时间与工具执行数：agent_end 时用于生成 agentSummary（触发「大折叠」）
    var roundStartTime = 0;
    var roundToolCount = 0;
    // 当前思考块的 id 与文本：正文/工具调用出现时，提前把思考定稿（thinking_end 在消息末尾才来）
    var activeThinkingId = '';
    var activeThinkingText = '';

    return function emit(event) {
      switch (event.type) {
        case 'agent_start':
          // 新一轮开始：清空本轮临时状态
          argBuffers = {};
          lastArgs = {};
          roundStartTime = Date.now();
          roundToolCount = 0;
          activeThinkingId = '';
          activeThinkingText = '';
          break;

        case 'message_start': {
          var m = event.message;
          if (m.role === 'user') {
            chat.enqueue({
              id: nextId('u'), senderId: 'me', type: 'text',
              content: contentToText(m.content), images: contentToImages(m.content), time: now(), isSelf: true
            });
          } else if (m.role === 'assistant') {
            assistantPrefix = 'a-' + (++seq);
          }
          // role === 'toolResult'：结果已在工具卡展示，这里忽略
          break;
        }

        case 'message_update': {
          var ev = event.assistantMessageEvent;
          var idx = ev.contentIndex;
          var block = event.message && event.message.content && event.message.content[idx];
          if (!block) break;

          if (block.type === 'thinking') {
            var thinkingStatus = ev.type === 'thinking_end' ? 'done' : 'thinking';
            if (thinkingStatus === 'thinking') {
              activeThinkingId = assistantPrefix + '#' + idx;
              activeThinkingText = block.thinking;
            }
            chat.enqueue({
              id: assistantPrefix + '#' + idx, senderId: 'agent', type: 'thinking',
              content: '', time: now(), isSelf: false,
              thinking: { text: block.thinking, fullText: block.thinking, status: thinkingStatus }
            });
          } else {
            // 正文/工具调用出现 = 推理已结束：提前把思考块定稿，避免 orb 一直转到消息末尾
            if (activeThinkingId) {
              chat.enqueue({
                id: activeThinkingId, senderId: 'agent', type: 'thinking',
                content: '', time: now(), isSelf: false,
                thinking: { text: activeThinkingText, fullText: activeThinkingText, status: 'done' }
              });
              activeThinkingId = '';
            }

            if (block.type === 'text') {
              chat.enqueue({
                id: assistantPrefix + '#' + idx, senderId: 'agent', type: 'text',
                content: block.text, time: now(), isSelf: false
              });
            } else if (block.type === 'toolCall') {
              var tcid = block.id;
              var argsToShow;
              if (ev.type === 'toolcall_start') {
                argBuffers[tcid] = '';
                argsToShow = '…'; // 参数生成中占位
              } else if (ev.type === 'toolcall_delta') {
                argBuffers[tcid] = (argBuffers[tcid] || '') + ev.delta;
                argsToShow = argBuffers[tcid] + '…';
              } else {
                // toolcall_end：参数完整
                argsToShow = ev.toolCall.arguments;
              }
              chat.enqueue({
                id: toolCardId(tcid), senderId: 'agent', type: 'toolCall',
                content: '', time: now(), isSelf: false,
                toolCall: {
                  toolCallId: tcid, toolName: block.name, toolType: 'builtin',
                  args: argsToShow, status: 'running'
                }
              });
            }
          }
          break;
        }

        case 'message_end': {
          var m = event.message;
          if (m.role === 'assistant' && m.stopReason === 'length') {
            // 输出被 token 上限截断：给最后一块 text 打 truncated 标记
            var content = m.content || [];
            for (var i = content.length - 1; i >= 0; i--) {
              if (content[i].type === 'text') {
                chat.enqueue({
                  id: assistantPrefix + '#' + i, senderId: 'agent', type: 'text',
                  content: content[i].text, time: now(), isSelf: false, truncated: true
                });
                break;
              }
            }
          }
          break;
        }

        case 'tool_execution_start':
          lastArgs[event.toolCallId] = event.args;
          roundToolCount++;
          chat.enqueue({
            id: toolCardId(event.toolCallId), senderId: 'agent', type: 'toolCall',
            content: '', time: now(), isSelf: false,
            toolCall: {
              toolCallId: event.toolCallId, toolName: event.toolName, toolType: 'builtin',
              args: event.args, status: 'running'
            }
          });
          break;

        case 'tool_execution_update':
          chat.enqueue({
            id: toolCardId(event.toolCallId), senderId: 'agent', type: 'toolCall',
            content: '', time: now(), isSelf: false,
            toolCall: {
              toolCallId: event.toolCallId, toolName: event.toolName, toolType: 'builtin',
              args: event.args, status: 'running',
              resultText: contentToText(event.partialResult && event.partialResult.content),
              images: contentToImages(event.partialResult && event.partialResult.content)
            }
          });
          break;

        case 'tool_execution_end': {
          var result = event.result;
          var text = contentToText(result && result.content);
          var detailsJson = stringifyDetails(result && result.details);
          if (detailsJson) text += (text ? '\n\n' : '') + detailsJson;
          chat.enqueue({
            id: toolCardId(event.toolCallId), senderId: 'agent', type: 'toolCall',
            content: '', time: now(), isSelf: false,
            toolCall: {
              toolCallId: event.toolCallId, toolName: event.toolName, toolType: 'builtin',
              args: lastArgs[event.toolCallId], status: event.isError ? 'failed' : 'done', resultText: text,
              summary: result && result.summary,
              images: contentToImages(result && result.content)
            }
          });
          break;
        }

        case 'agent_end':
          // 本轮结束：有工具执行时发 agentSummary，触发「任务总结栏 + 大折叠」
          if (roundToolCount > 0) {
            chat.enqueue({
              id: nextId('sum'), senderId: 'agent', type: 'agentSummary',
              content: '', time: now(), isSelf: false,
              agentSummary: {
                taskCount: roundToolCount,
                durationMs: Date.now() - roundStartTime
              }
            });
          }
          break;
      }
    };
  }

  global.makePiAgentAdapter = makePiAgentAdapter;
})(window);
