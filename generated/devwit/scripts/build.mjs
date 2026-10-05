/**
 * 跨包管理器构建编排（v0.7.31）。
 *
 * 旧 "build"/"pack"/"dist" 脚本内部硬编码 `npm run ...` 链式调用——环境里只有
 * pnpm/yarn 时直接失败（实测：'npm' is not recognized）。本脚本直接驱动本地
 * node_modules 里的工具，npm / pnpm / yarn 均可作脚本运行器。
 *
 * 实现注记：
 * - tsc 经 `node typescript/bin/tsc` 驱动——bin/tsc 是带 shebang 的 JS，
 *   三平台一致（Node 22+ 无 shell spawn .cmd 会 EINVAL，故不走红 bin shim）。
 * - esbuild 经 **JavaScript API**（import "esbuild"）调用——CLI 的
 *   `bin/esbuild` 在 POSIX 会被 postinstall 替换为原生二进制（ELF/Mach-O），
 *   `node bin/esbuild` 直接 SyntaxError（v0.7.31 Release 首跑 mac/linux 即栽
 *   在此）；JS API 无此平台差异，且 banner/external/loader 参数结构化传递。
 * - 步骤与原 package.json 定义一一对应：tsc -b → renderer/main/preload/
 *   searchworker bundle → 拷贝 index.html。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tool = (pkgEntryPoint) => path.join(root, "node_modules", pkgEntryPoint);

const MAIN_BANNER = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);";

function runTsc() {
  console.log("[build] tsc -b（类型检查 + 项目引用）");
  const result = spawnSync(process.execPath, [tool("typescript/bin/tsc"), "-b"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`[build] FAILED at: tsc -b (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

async function runEsbuild(label, options) {
  console.log(`[build] ${label}`);
  await build(options);
}

async function main() {
  runTsc();

  await runEsbuild("renderer bundle", {
    entryPoints: [path.join(root, "apps/desktop/src/renderer/index.ts")],
    bundle: true,
    outfile: path.join(root, "apps/desktop/dist/renderer/index.js"),
    format: "iife",
    target: "chrome130",
    sourcemap: true,
    loader: { ".css": "css" },
  });

  await runEsbuild("main bundle", {
    entryPoints: [path.join(root, "apps/desktop/src/main/index.ts")],
    bundle: true,
    outfile: path.join(root, "apps/desktop/dist/main/index.js"),
    format: "esm",
    platform: "node",
    target: "node20",
    external: ["electron", "node-pty"],
    banner: { js: MAIN_BANNER },
  });

  await runEsbuild("preload bundle", {
    entryPoints: [path.join(root, "apps/desktop/src/main/preload.ts")],
    bundle: true,
    outfile: path.join(root, "apps/desktop/dist/main/preload.cjs"),
    format: "cjs",
    platform: "node",
    external: ["electron"],
  });

  await runEsbuild("search-worker bundle", {
    entryPoints: [path.join(root, "packages/workspace/src/search-worker.ts")],
    bundle: true,
    outfile: path.join(root, "apps/desktop/dist/main/search-worker.mjs"),
    format: "esm",
    platform: "node",
    target: "node20",
  });

  fs.copyFileSync(
    path.join(root, "apps/desktop/src/renderer/index.html"),
    path.join(root, "apps/desktop/dist/renderer/index.html")
  );
  console.log("[build] index.html copied — all steps OK");
}

await main();
