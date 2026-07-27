/**
 * GitMainService（迭代 32 / AC41）：主进程 Git 门面。
 * 每个工作区根绑定一个 packages/workspace GitService（真实 git CLI）；
 * stage/unstage/commit 操作成功后即时推送 git:changed 全量快照，
 * 工作区文件事件由渲染端订阅 workspace.onEvent 防抖后自查 getStatus（主进程不耦合 watcher）。
 * 非 git 仓库 status 返回 null（渲染端显引导态），不抛错。
 */
import { IPC } from "@devwit/contracts";
import type { GitDiffTexts, GitPanelStatus } from "@devwit/contracts";
import { GitService } from "@devwit/workspace";

export interface GitMainServiceDeps {
  send(channel: string, ...args: unknown[]): void;
}

export class GitMainService {
  private service: GitService | null = null;

  constructor(private readonly deps: GitMainServiceDeps) {}

  /** 工作区打开钩子（WorkspaceOpenDialog/WorkspaceTree 调用）：换绑仓库根并推送初态。 */
  openWorkspace(root: string): void {
    this.service = new GitService(root);
    void this.pushChanged();
  }

  status(): Promise<GitPanelStatus | null> {
    return this.service?.status() ?? Promise.resolve(null);
  }

  diffTexts(relPath: string): Promise<GitDiffTexts> {
    return this.requireService().diffTexts(relPath);
  }

  async stage(relPath: string): Promise<void> {
    await this.requireService().stage(relPath);
    await this.pushChanged();
  }

  async unstage(relPath: string): Promise<void> {
    await this.requireService().unstage(relPath);
    await this.pushChanged();
  }

  async commit(message: string): Promise<void> {
    await this.requireService().commit(message);
    await this.pushChanged();
  }

  private requireService(): GitService {
    if (this.service === null) {
      throw new Error("DW_GIT_NOT_REPO");
    }
    return this.service;
  }

  private async pushChanged(): Promise<void> {
    this.deps.send(IPC.GitChanged, await this.status());
  }
}
