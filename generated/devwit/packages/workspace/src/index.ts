/** @devwit/workspace — 工作区与文件树服务（WU005）。仅供 Electron 主进程使用（AR004）。 */
export { buildFileTree } from "./file-tree.js";
export type { BuildFileTreeOptions, FileTreeNode } from "./file-tree.js";
export { WorkspaceService } from "./workspace-service.js";
export type { WorkspaceChangeListener, WorkspaceEvent } from "./workspace-service.js";
export { getGitStatus } from "./git-status.js";
export type { GitChangedFile, GitStatusResult } from "./git-status.js";
export { GitService, parsePorcelainZ } from "./git-service.js";
export type { GitDiffTexts, GitExecFile, GitFileChange, GitPanelStatus } from "./git-service.js";
