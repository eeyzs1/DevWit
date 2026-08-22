/**
 * 示例项目脚手架（增长 D3 / v0.6.0）：一键生成一个可运行的迷你 Web 应用。
 *
 * 设计目标：让新用户打开即见 DevWit 的 IDE 能力全景——文件树 / LSP / 类型 /
 * 可构建运行，并在 README 引导下走一遍核心闭环：
 *   ① 让 Agent 解释代码（看上下文面板逐项 token）
 *   ② 让 Agent 修复预埋 bug（看授权门批准写文件 + diff 逐块审查）
 *   ③ 让 Agent 安装依赖并构建运行（看授权门批准终端命令）
 *
 * 模板文件以相对路径为键（固定字面量，无路径穿越面）；写文件为覆盖语义
 * （用户主动选择的目标目录，视为其意图所在）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 示例项目文件模板：相对路径 → 内容。 */
const TEMPLATE: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify(
    {
      name: "devwit-sample-todo",
      version: "0.1.0",
      private: true,
      description: "DevWit 示例项目：迷你 Todo Web 应用（TypeScript）",
      scripts: {
        build: "tsc",
        dev: "tsc --watch",
        serve: "npx serve .",
      },
      devDependencies: {
        typescript: "^5.5.0",
      },
    },
    null,
    2
  ) + "\n",

  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "bundler",
        strict: true,
        outDir: "dist",
        rootDir: "src",
        lib: ["ES2022", "DOM"],
      },
      include: ["src"],
    },
    null,
    2
  ) + "\n",

  "index.html": `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DevWit Sample · Todo</title>
  <link rel="stylesheet" href="src/styles.css" />
</head>
<body>
  <main class="app">
    <h1>Todo · DevWit Sample</h1>
    <form id="add-form" class="add-row">
      <input id="new-todo" type="text" placeholder="Add a todo…" autocomplete="off" />
      <button type="submit">Add</button>
    </form>
    <div class="filters">
      <button data-filter="all">All</button>
      <button data-filter="active">Active</button>
      <button data-filter="completed">Completed</button>
    </div>
    <ul id="todo-list"></ul>
    <p id="count" class="count"></p>
  </main>
  <script type="module" src="dist/main.js"></script>
</body>
</html>
`,

  "src/styles.css": `body {
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  margin: 0;
  background: #f5f6f8;
  color: #1a1a1b;
}
.app {
  max-width: 520px;
  margin: 48px auto;
  padding: 24px;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}
.add-row {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.add-row input {
  flex: 1;
  padding: 8px 10px;
  border: 1px solid #d3d6da;
  border-radius: 6px;
}
.filters {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}
.filters button {
  padding: 4px 12px;
  border: 1px solid #d3d6da;
  border-radius: 999px;
  background: #fff;
  cursor: pointer;
}
.filters button.active {
  background: #4f8cff;
  color: #fff;
  border-color: #4f8cff;
}
ul {
  list-style: none;
  padding: 0;
  margin: 0 0 12px;
}
li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 4px;
  border-bottom: 1px solid #eee;
}
li.completed span {
  text-decoration: line-through;
  color: #999;
}
.count {
  color: #666;
  font-size: 13px;
}
`,

  "src/todo.ts": `/** Todo 数据模型：类型 + 增删改查（纯逻辑，无 DOM 依赖）。 */
export interface Todo {
  id: number;
  title: string;
  completed: boolean;
}

export type TodoFilter = "all" | "active" | "completed";

let nextId = 1;

export function createTodo(title: string): Todo {
  return { id: nextId++, title: title.trim(), completed: false };
}

export function toggleTodo(todos: Todo[], id: number): Todo[] {
  return todos.map((todo) => (todo.id === id ? { ...todo, completed: !todo.completed } : todo));
}

export function removeTodo(todos: Todo[], id: number): Todo[] {
  return todos.filter((todo) => todo.id !== id);
}

export function filterTodos(todos: Todo[], filter: TodoFilter): Todo[] {
  if (filter === "active") return todos.filter((todo) => !todo.completed);
  if (filter === "completed") return todos.filter((todo) => todo.completed);
  // TODO(bug): "all" 过滤当前误返回未完成项——已完成项在 All 视图下被隐藏。
  // 试试让 Agent 修复它：这是观察 上下文面板 → 授权门 → diff 审查 的入口。
  return todos.filter((todo) => !todo.completed);
}

export function countActive(todos: Todo[]): number {
  return todos.filter((todo) => !todo.completed).length;
}
`,

  "src/main.ts": `import { countActive, createTodo, filterTodos, removeTodo, toggleTodo, type Todo, type TodoFilter } from "./todo.js";

const form = document.getElementById("add-form") as HTMLFormElement;
const input = document.getElementById("new-todo") as HTMLInputElement;
const list = document.getElementById("todo-list") as HTMLUListElement;
const countEl = document.getElementById("count") as HTMLParagraphElement;
const filterButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".filters button"));

let todos: Todo[] = [
  createTodo("看看上下文面板：让 Agent 解释这段代码"),
  createTodo("让 Agent 修复 All 过滤器的 bug"),
  createTodo("让 Agent 安装依赖并构建运行"),
];
let filter: TodoFilter = "all";

function render(): void {
  const visible = filterTodos(todos, filter);
  list.textContent = "";
  for (const todo of visible) {
    const li = document.createElement("li");
    li.className = todo.completed ? "completed" : "";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = todo.completed;
    checkbox.addEventListener("change", () => {
      todos = toggleTodo(todos, todo.id);
      render();
    });
    const span = document.createElement("span");
    span.textContent = todo.title;
    const remove = document.createElement("button");
    remove.textContent = "✕";
    remove.addEventListener("click", () => {
      todos = removeTodo(todos, todo.id);
      render();
    });
    li.append(checkbox, span, remove);
    list.appendChild(li);
  }
  countEl.textContent = \`\${countActive(todos)} active / \${todos.length} total\`;
  for (const button of filterButtons) {
    button.classList.toggle("active", button.dataset["filter"] === filter);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = input.value;
  if (title.trim() === "") return;
  todos = [...todos, createTodo(title)];
  input.value = "";
  render();
});

for (const button of filterButtons) {
  button.addEventListener("click", () => {
    filter = (button.dataset["filter"] ?? "all") as TodoFilter;
    render();
  });
}

render();
`,

  "README.md": `# DevWit Sample · 迷你 Todo Web 应用

这是一个故意留了点小问题的 TypeScript 小项目，用来体验 DevWit 的核心闭环（约 3 分钟）。

## 三个任务

1. **让 Agent 解释代码**：在对话里输入「解释一下 src/todo.ts 的 filterTodos 做了什么」。
   注意看上下文面板——这次请求注入了哪些文件、各占多少 token，都可以逐项开关。

2. **让 Agent 修复 bug**：输入「src/todo.ts 的 filterTodos 在 All 过滤下把已完成项也隐藏了，帮我修好」。
   修改文件前会弹出授权门——批准后修改以 diff 形式呈现，可逐块接受/拒绝。

3. **让 Agent 构建运行**：输入「帮我安装依赖并构建，然后告诉我怎么打开页面」。
   Agent 执行 npm 命令同样需要你批准（可「按项目记住」安全命令）。

## 手动构建

\`\`\`bash
npm install
npm run build   # tsc → dist/main.js
npm run serve   # 或直接双击 index.html（需先构建）
\`\`\`

## 技术栈

TypeScript（strict）+ 原生 DOM，零运行时依赖。
`,
};

/** 写入示例项目到目标目录（覆盖语义），返回已创建的文件相对路径清单。 */
export function scaffoldSampleProject(root: string): Promise<string[]> {
  const created: string[] = [];
  for (const [relative, content] of Object.entries(TEMPLATE)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf-8");
    created.push(relative);
  }
  return Promise.resolve(created);
}
