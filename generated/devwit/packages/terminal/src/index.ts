/** @devwit/terminal — 终端后端（WU006）。仅供 Electron 主进程使用（AR004）。 */
export type {
  TerminalBackend,
  TerminalExitInfo,
  TerminalHandle,
  TerminalSpawnOptions
} from "./types.js";
export { defaultShell } from "./types.js";
export { PipeBackend } from "./pipe-backend.js";
export { NodePtyUnavailableError, PtyBackend } from "./pty-backend.js";
export { TerminalService } from "./terminal-service.js";
export type { TerminalCreateOptions } from "./terminal-service.js";
