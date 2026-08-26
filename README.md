# Agent 消息组件 + pi-agent 接入套件

把 pi-agent 一轮 agent loop 的「思考 → 工具 → 回答」输出流，渲染成聊天窗里一条完整的 Agent 消息（中间过程自动折叠归档）。

## 目录

| 文件 | 作用 |
|------|------|
| `agent-message.css` | 渲染组件样式（自带 `:root` 默认主题） |
| `agent-message.js` | 渲染组件 `AgentChat`（含 `DEFAULTS` 配置，`opts` 覆盖） |
| `liquid-orb.js` | **必选**动效：思考/运行的液态球（WebGPU，自动降级粒子球） |
| `pi-agent-adapter.js` | 适配层：pi-agent `AgentEvent` → 组件消息 |
| `server.mjs` | 参考后端：`Agent` 订阅 + WebSocket 桥接 |
| `demo.html` | 最小可运行示例（stub 生产者） |

---

## 一、渲染组件（AgentChat）

### 引入

```html
<link rel="stylesheet" href="agent-message.css">
<script src="liquid-orb.js"></script>   <!-- 必选，见「二、必选动效」 -->
<script src="agent-message.js"></script>
```

### 实例化

```js
var chat = new AgentChat(listEl, {
  onFollowChange: function (following) { /* 是否贴近底部（自动滚动）切换 */ },
  onRetry:       function (round)       { /* 工具卡「重试」按钮 */ },
  onRegenerate:  function (round)       { /* 操作栏「重新生成」按钮 */ },
  toast:         function (msg)         { /* 提示条 */ },

  // 可选：覆盖默认文案/图标（浅合并，不传则用默认值）
  text: { callBuiltin: 'Invoke tool' }
});
```

`listEl` 是消息列表的滚动容器 DOM 元素（由宿主页提供）。

### 方法

| 方法 | 说明 |
|------|------|
| `enqueue(msg)` | 喂入一条消息；同一 `id` 重复喂入 = 原地流式更新 |
| `completeCurrentRound()` | 本轮结束：定稿最终回答、加操作栏、关闭本轮 |
| `abortCurrentRound()` | 停止：标记中断、折叠中间过程 |
| `removeRound(round)` | 删除某一轮 |
| `clearAll()` | 清空全部 |
| `scrollToBottom()` | 滚动到底 |
| `showToolbar(round)` | 显示某轮操作栏（复制 / 重新生成） |

### 消息协议

组件只认消息流，不关心生产者是谁。同一条消息用**稳定 `id`** 反复 `emit` 即可流式更新（思考逐字、工具 `running → done`）。

| type | 字段 | 说明 |
|------|------|------|
| `text` | `content`、`time`、`isSelf`、`images?`、`truncated?` | `isSelf:true` 是用户消息；否则是 agent 的中间说明或最终回答 |
| `thinking` | `thinking.text` / `thinking.fullText` / `thinking.status` | 流式思考块，`status` = `thinking` / `done` |
| `toolCall` | `toolCall.toolName` / `toolType` / `mcpType` / `args` / `status` / `summary` / `resultText` | 工具卡；`toolType` = `builtin` / `skill` / `mcp`；`status` = `running` / `done` / `failed` / `warn` |
| `toolResult` | `toolResult.toolCallId` / `content` | 工具原始结果，按 `toolCallId` 关联到工具卡 |
| `file` | `file.name` / `file.content` | 文件卡 |
| `agentSummary` | `agentSummary.taskCount` / `durationMs` | 总结栏；触发中间过程折叠 |

关键规则：

- 同一轮的中间消息共享 `groupId`（组件内部按顺序自动分轮）。
- 最后一个 `text` 是**最终回答**（视觉权重最高）。
- `agentSummary` 总是最后一条；到达后中间过程（思考 / 工具 / 中间说明）自动折叠，只留「总结栏 + 最终回答」，点总结栏可展开。

### 主题 token（可覆盖）

组件 CSS 自带 `:root` 默认值，宿主页定义同名变量即可换肤：

`--bg-0/1/2`、`--glass`、`--glass-strong`、`--border`、`--border-strong`、`--text-1/2/3`、`--accent-1/2/3`、`--grad`、`--grad-user`、`--ok`、`--warn`、`--err`、`--mono`、`--sans`。

### 配置项（DEFAULTS，`opts` 覆盖）

构造时传 `opts.text` / `opts.thinkingPhrases` / `opts.paramLabels` / `opts.toolIcons` / `opts.toolMeta` / `opts.mcpType`，对默认值做浅合并（映射按 key 合并，`thinkingPhrases` 整数组替换）。

`opts.text` 常用 key（完整清单见 `agent-message.js` 顶部 `DEFAULTS_TEXT`）：

`callBuiltin`（调用内置工具）、`callSkill`（载入技能）、`callMcp`（调用MCP）、`execFailed`（执行失败）、`execWarn`（执行告警）、`cost`（耗时）、`failed`（失败）、`warn`（告警）、`retry`（重试）、`copy` / `copied` / `copyFailed`、`download`（下载）、`summaryLead` / `summaryTasks`（总结栏）、`thinkingSecs`（思考 N 秒）、`stopped` / `truncated` 等。

---

## 二、必选动效：液态球

`liquid-orb.js` 是**必选依赖**，不是可选。它暴露 `window.makeLiquidOrb(hostEl, size)`：

- **优先 WebGPU 渲染「液态球」**（思考区与工具运行外圈的动画）。
- 仅当 WebGPU 不可用（`navigator.gpu` 缺失 / `requestAdapter`、`requestDevice` 失败 / shader 编译失败 / `device.lost` / 渲染异常）时，**自动降级**为 2D canvas「粒子球」。
- 降级**全在 `liquid-orb.js` 内部完成**，接入方无需写任何降级代码。

渲染器对 `window.makeLiquidOrb` 做特性检测：只要引入了 `liquid-orb.js` 就有动效；**漏引该脚本会导致思考区没有动效**（属配置遗漏，务必引入）。

---

## 三、适配层（pi-agent-adapter.js）

`makePiAgentAdapter(chat)` → 返回 `emit(event)`。一个 pi-agent 的 `AgentEvent` 进来，翻译成零到多条组件消息（通过 `chat.enqueue` 喂给渲染器）。

```js
var emit = makePiAgentAdapter(chat);
// 把 emit 作为 runAgentLoop 的事件 sink，或接到 WebSocket 收包回调
```

### 适配依据逻辑（事件 → 消息映射）

| AgentEvent | 组件消息 |
|-----------|---------|
| `agent_start` | 清空本轮临时状态（参数缓冲 / 计时 / 思考块） |
| `message_start`（role=user） | 用户 `text`；assistant → 记内容块 id 前缀 |
| `message_update`（`assistantMessageEvent`，按 `block.type`） | `thinking` → thinking（`thinking_end` 置 done；正文/工具出现时提前定稿思考块）；`text` → text；`toolCall` → toolCall（`toolcall_start` 参数占位「…」、`toolcall_delta` 累加、`toolcall_end` 完整参数） |
| `message_end`（stopReason=length） | 给最后 text 打 `truncated` |
| `tool_execution_start` | 工具卡 running（记 args、计数） |
| `tool_execution_update` | 工具卡 running + 部分结果快照 |
| `tool_execution_end` | 工具卡 done / failed（`isError`）+ 完整 resultText（含结构化 details）+ summary + images |
| `agent_end` | 有工具时发 `agentSummary`（taskCount + durationMs），触发折叠 |

id 约定（稳定 id 支撑流式 upsert）：用户 `u-<n>`、assistant 内容块 `a-<n>#<contentIndex>`、工具卡 `tc-<toolCallId>`。

两个扩展点（按需改适配层）：

- 当前把工具执行统一映射为 `toolType:'builtin'`；若你的 agent 有 MCP / Skill 工具，需在 `tool_execution_*` 里按工具元数据区分 `mcp` / `skill`。
- 真实 pi-agent 事件只有成功 / 失败，无 `warn` 状态（`warn` 是组件 mock 特性）。

---

## 四、pi-agent 入口签名

- 低层：`runAgentLoop(prompts, context, config, emit, signal, streamFn)`，`emit` 是 `AgentEventSink`（收到上面那些 `AgentEvent`）。
- 高层：`Agent`（`@earendil-works/pi-agent-core`）——`new Agent({ streamFn, getApiKey, initialState })` + `.prompt(text)` / `.continue()` / `.abort()` / `.subscribe(cb)` / `.state.messages`。`Agent` 内部调 `runAgentLoop`。

---

## 五、两种接入路径

### 路径 A：进程内直连（同进程直接调 runAgentLoop）

```js
var chat = new AgentChat(listEl, opts);
var emit = makePiAgentAdapter(chat);
await runAgentLoop(prompts, ctx, config, emit, signal, streamFn);
```

### 路径 B：WebSocket 桥接（参考 server.mjs）

`server.mjs` 用 `Agent.subscribe` 把事件 JSON 转发给浏览器，前端 `ws.onmessage → emit(event)`：

- 客户端 → 服务端：`{type:'prompt', text}` / `{type:'stop'}` / `{type:'regenerate'}`。
- 服务端 → 客户端：pi-agent `AgentEvent` 的 JSON + `{type:'error', error}`。

`server.mjs` 是参考实现：需放进你自己的 pi-agent 工程、能解析 `@earendil-works/pi-agent-core` / `ws` / `typebox`，配 `DEEPSEEK_API_KEY`（或改 `getApiKey`）后 `node server.mjs` 运行，并按你的工具集 / 模型改 `TOOLS` 与 `model`。

---

## 最小接入示例

- `demo.html`：前端 stub 生产者，演示「实例化 → `enqueue` → `completeCurrentRound`」。
- 仓库根目录 `real.html` + `node server.mjs`：真实 pi-agent 联调。
