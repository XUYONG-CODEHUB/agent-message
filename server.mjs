// pi-agent 真实 agent loop 联调后端（带工具）
// 用法：DEEPSEEK_API_KEY=sk-xxx node server.mjs
// 前端连 ws://localhost:8080

import { WebSocketServer } from "ws";
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { exec as execCb } from "node:child_process";
import {
  readFile,
  writeFile,
  appendFile,
  readdir,
  rm,
  rename,
  mkdir,
} from "node:fs/promises";
import { join, relative, basename } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCb);

const PORT = 8080;
const API_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL_ID = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

if (!API_KEY) {
  console.error("缺少 DEEPSEEK_API_KEY，请先 export DEEPSEEK_API_KEY=sk-xxx 再启动。");
  process.exit(1);
}

// 手动构造 DeepSeek Model（模型目录因网络不可用而 stub 掉了，这里直接给）
const model = {
  id: MODEL_ID,
  name: "DeepSeek V4 Flash",
  api: "openai-completions",
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  reasoning: false,
  input: ["text"],
  contextWindow: 1000000,
  maxTokens: 8192,
  cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 },
};

// ---- 工具辅助：通配符 → 正则；递归列文件 ----
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}

async function walkFiles(dir, signal) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true, signal });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      out.push(...(await walkFiles(p, signal)));
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

// ---- 工具定义 ----
const bashTool = {
  name: "bash",
  label: "bash",
  description: "执行 shell 命令，返回 stdout 与 stderr",
  parameters: Type.Object({ command: Type.String() }),
  execute: async (_id, { command }, signal) => {
    const { stdout, stderr } = await exec(command, { signal, timeout: 30000 });
    const text = (stdout || "") + (stderr ? "\n[stderr]\n" + stderr : "");
    return { content: [{ type: "text", text: text || "(无输出)" }], details: {}, summary: "执行了 1 条命令" };
  },
};

const readTool = {
  name: "read",
  label: "read",
  description: "读取文件内容（utf-8）",
  parameters: Type.Object({ path: Type.String() }),
  execute: async (_id, { path }, signal) => {
    const content = await readFile(path, { encoding: "utf-8", signal });
    return { content: [{ type: "text", text: content }], details: {}, summary: "读取了 1 个文件" };
  },
};

const writeTool = {
  name: "write",
  label: "write",
  description: "写入文件内容（默认覆盖；append=true 时追加）",
  parameters: Type.Object({
    path: Type.String(),
    content: Type.String(),
    append: Type.Optional(Type.Boolean()),
  }),
  execute: async (_id, { path, content, append }, signal) => {
    if (append) {
      await appendFile(path, content, { encoding: "utf-8", signal });
    } else {
      await writeFile(path, content, { encoding: "utf-8", signal });
    }
    return { content: [{ type: "text", text: "已写入 " + path }], details: {}, summary: append ? "追加了 1 个文件" : "写入了 1 个文件" };
  },
};

const editTool = {
  name: "edit",
  label: "edit",
  description: "在文件中查找并替换文本（默认替换第一处；replaceAll=true 替换全部）",
  parameters: Type.Object({
    path: Type.String(),
    oldText: Type.String(),
    newText: Type.String(),
    replaceAll: Type.Optional(Type.Boolean()),
  }),
  execute: async (_id, { path, oldText, newText, replaceAll }, signal) => {
    const content = await readFile(path, { encoding: "utf-8", signal });
    if (!content.includes(oldText)) {
      throw new Error("未找到要替换的内容：" + oldText);
    }
    const next = replaceAll
      ? content.split(oldText).join(newText)
      : content.replace(oldText, () => newText);
    const count = replaceAll ? content.split(oldText).length - 1 : 1;
    await writeFile(path, next, { encoding: "utf-8", signal });
    return { content: [{ type: "text", text: "已编辑 " + path }], details: {}, summary: "替换了 " + count + " 处" };
  },
};

const listTool = {
  name: "list",
  label: "list",
  description: "列出目录内容（path 默认当前目录；pattern 支持通配符 * ?）",
  parameters: Type.Object({
    path: Type.Optional(Type.String()),
    pattern: Type.Optional(Type.String()),
  }),
  execute: async (_id, { path, pattern }, signal) => {
    const dir = path || ".";
    const entries = await readdir(dir, { withFileTypes: true, signal });
    let names = entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name));
    if (pattern) {
      const re = globToRegExp(pattern);
      names = names.filter((n) => re.test(n));
    }
    names.sort();
    return { content: [{ type: "text", text: names.join("\n") || "(空)" }], details: {}, summary: "列出了 " + names.length + " 项" };
  },
};

const searchTool = {
  name: "search",
  label: "search",
  description: "递归搜索文件内容（正则匹配），返回 相对路径:行号:内容；glob 可过滤文件名（如 *.js）",
  parameters: Type.Object({
    pattern: Type.String(),
    path: Type.Optional(Type.String()),
    glob: Type.Optional(Type.String()),
  }),
  execute: async (_id, { pattern, path, glob }, signal) => {
    const root = path || ".";
    const re = new RegExp(pattern);
    const fileRe = glob ? globToRegExp(glob) : null;
    let files = await walkFiles(root, signal);
    if (fileRe) files = files.filter((f) => fileRe.test(basename(f)));
    const hits = [];
    for (const f of files) {
      let text;
      try {
        text = await readFile(f, { encoding: "utf-8", signal });
      } catch (e) {
        continue;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) hits.push(relative(root, f) + ":" + (i + 1) + ": " + lines[i].trim());
      }
    }
    const text = hits.slice(0, 500).join("\n") || "(无匹配)";
    return { content: [{ type: "text", text }], details: {}, summary: "匹配到 " + hits.length + " 处" };
  },
};

const deleteTool = {
  name: "delete",
  label: "delete",
  description: "删除文件或目录（recursive=true 时递归删除目录）",
  parameters: Type.Object({
    path: Type.String(),
    recursive: Type.Optional(Type.Boolean()),
  }),
  execute: async (_id, { path, recursive }, signal) => {
    await rm(path, { recursive: !!recursive, force: false, signal });
    return { content: [{ type: "text", text: "已删除 " + path }], details: {}, summary: "删除了 1 个文件" };
  },
};

const moveTool = {
  name: "move",
  label: "move",
  description: "移动或重命名文件/目录（from → to）",
  parameters: Type.Object({ from: Type.String(), to: Type.String() }),
  execute: async (_id, { from, to }) => {
    await rename(from, to);
    return { content: [{ type: "text", text: "已移动 " + from + " → " + to }], details: {}, summary: "移动了 1 个文件" };
  },
};

const mkdirTool = {
  name: "mkdir",
  label: "mkdir",
  description: "创建目录（recursive=true 时创建多级目录）",
  parameters: Type.Object({
    path: Type.String(),
    recursive: Type.Optional(Type.Boolean()),
  }),
  execute: async (_id, { path, recursive }) => {
    await mkdir(path, { recursive: !!recursive });
    return { content: [{ type: "text", text: "已创建目录 " + path }], details: {}, summary: "创建了 1 个目录" };
  },
};

const cwdTool = {
  name: "cwd",
  label: "cwd",
  description: "返回当前工作目录绝对路径",
  parameters: Type.Object({}),
  execute: async () => {
    return { content: [{ type: "text", text: process.cwd() }], details: {}, summary: "获取了当前目录" };
  },
};

const TOOLS = [
  bashTool,
  readTool,
  writeTool,
  editTool,
  listTool,
  searchTool,
  deleteTool,
  moveTool,
  mkdirTool,
  cwdTool,
];

function createAgent() {
  return new Agent({
    streamFn: streamSimple,
    getApiKey: () => API_KEY,
    initialState: {
      model,
      systemPrompt:
        "你是一个有用的助手，可以在当前工作目录读写文件、执行命令、搜索内容、管理文件。",
      tools: TOOLS,
      thinkingLevel: "off",
    },
  });
}

const wss = new WebSocketServer({ port: PORT });
console.log(`pi-agent 联调后端已启动：ws://localhost:${PORT}（model=${MODEL_ID}，工具=${TOOLS.map((t) => t.name).join(",")}）`);

wss.on("connection", (ws) => {
  const agent = createAgent();
  const unsubscribe = agent.subscribe(async (event) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(event));
    }
  });

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (err) { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'stop') {
      agent.abort();
      return;
    }

    if (msg.type === 'regenerate') {
      // 重新生成：从末尾移除上一轮 assistant 回复及其 tool 结果，再 continue
      const messages = agent.state.messages.slice();
      while (messages.length > 0) {
        const last = messages[messages.length - 1];
        if (last.role === 'assistant' || last.role === 'toolResult') {
          messages.pop();
        } else {
          break;
        }
      }
      agent.state.messages = messages;
      agent.continue().catch((err) => {
        console.error("agent.continue 失败:", err);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "error", error: String((err && err.message) || err) }));
        }
      });
      return;
    }

    if (msg.type === 'prompt') {
      const text = String(msg.text || '').trim();
      if (!text) return;
      agent.prompt(text).catch((err) => {
        console.error("agent.prompt 失败:", err);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "error", error: String((err && err.message) || err) }));
        }
      });
    }
  });

  ws.on("close", () => {
    agent.abort();
    unsubscribe();
  });
});
