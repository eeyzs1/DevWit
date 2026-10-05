/**
 * 跨包管理器构建编排（v0.7.31）。
 *
 * 旧 "build"/"pack"/"dist" 脚本内部硬编码 `npm run ...` 链式调用——环境里只有
 * pnpm/yarn 时直接失败（实测：'npm' is not recognized）。本脚本用 node 直接驱动
 * 本地 node_modules 里的工具入口，npm / pnpm / yarn 均可作脚本运行器。
 *
 * 步骤与原 package.json 定义一一对应：tsc -b → renderer/main/preload/searchworker
 * esbuild bundle → 拷贝 index.html。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tool = (pkgEntryPoint) => path.join(root, "node_modules", pkgEntryPoint);

const MAIN_BANNER = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);";

function run(args, label) {
  console.log(`[build] ${label}`);
  // 直接以 node 驱动工具 JS 入口（不经 .cmd shim——Node 22 起无 shell spawn
  // .cmd 会 EINVAL；且不依赖任何包管理器在 PATH 中）。
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`[build] FAILED at: ${label} (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

run([tool("typescript/bin/tsc"), "-b"], "tsc -b（类型检查 + 项目引用）");

run([tool("esbuild/bin/esbuild"),
  "apps/desktop/src/renderer/index.ts", "--bundle",
  "--outfile=apps/desktop/dist/renderer/index.js",
  "--format=iife", "--target=chrome130", "--sourcemap", "--loader:.css=css",
], "renderer bundle");

run([tool("esbuild/bin/esbuild"),
  "apps/desktop/src/main/index.ts", "--bundle",
  "--outfile=apps/desktop/dist/main/index.js",
  "--format=esm", "--platform=node", "--target=node20",
  "--external:electron", "--external:node-pty",
  `--banner:js=${MAIN_BANNER}`,
], "main bundle");

run([tool("esbuild/bin/esbuild"),
  "apps/desktop/src/main/preload.ts", "--bundle",
  "--outfile=apps/desktop/dist/main/preload.cjs",
  "--format=cjs", "--platform=node", "--external:electron",
], "preload bundle");

run([tool("esbuild/bin/esbuild"),
  "packages/workspace/src/search-worker.ts", "--bundle",
  "--outfile=apps/desktop/dist/main/search-worker.mjs",
  "--format=esm", "--platform=node", "--target=node20",
], "search-worker bundle");

fs.copyFileSync(
  path.join(root, "apps/desktop/src/renderer/index.html"),
  path.join(root, "apps/desktop/dist/renderer/index.html")
);
console.log("[build] index.html copied — all steps OK");
