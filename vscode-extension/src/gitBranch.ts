/**
 * The checked-out branch, read from VS Code's built-in Git extension (its public
 * API, not a git spawn — the CLI stays the only thing that runs git). The memory
 * view's "group by feature commit" mode needs a branch NAME: `hunch log --for HEAD`
 * means the checked-out commit, not its branch. Without the Git extension (disabled,
 * or no repository open yet) every lookup is undefined and the view asks for HEAD.
 */
import * as vscode from "vscode";
import { repoFor } from "./featureGroups.js";

/** The slice of the vscode.git API (v1) this reads. */
interface GitRepository {
  rootUri: vscode.Uri;
  /** HEAD.type 0 is a local branch (RefType.Head); name is absent when detached. */
  state: { HEAD?: { name?: string; commit?: string; type?: number }; onDidChange: vscode.Event<void> };
}
interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
}

export class GitBranches implements vscode.Disposable {
  private api: GitApi | undefined;
  private disposed = false;
  private readonly subs: vscode.Disposable[] = [];
  /** One state listener per watched repository, keyed by its root path. */
  private readonly repoSubs = new Map<string, vscode.Disposable>();

  /** `onChange` fires when a repository opens or closes, or its checked-out branch
   *  or commit moves (a new commit regroups the branch; a detached HEAD has no
   *  branch name to change). With the Git extension already active it first fires
   *  synchronously, inside this constructor. */
  constructor(private readonly onChange: () => void) {
    void this.connect();
  }

  private async connect(): Promise<void> {
    try {
      const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>("vscode.git");
      if (!ext) return;
      const exports = ext.isActive ? ext.exports : await ext.activate();
      if (this.disposed) return;
      const api = exports?.getAPI(1);
      if (!api) return;
      this.api = api;
      for (const repo of api.repositories) this.watch(repo);
      this.subs.push(api.onDidOpenRepository((repo) => { this.watch(repo); this.onChange(); }));
      this.subs.push(api.onDidCloseRepository((repo) => { this.unwatch(repo); this.onChange(); }));
      if (api.repositories.length) this.onChange();
    } catch { /* Git extension unavailable: grouping falls back to HEAD */ }
  }

  private watch(repo: GitRepository): void {
    const key = repo.rootUri.fsPath;
    this.repoSubs.get(key)?.dispose();
    let last = headKey(repo);
    this.repoSubs.set(key, repo.state.onDidChange(() => {
      const now = headKey(repo);
      if (now !== last) { last = now; this.onChange(); }
    }));
  }

  private unwatch(repo: GitRepository): void {
    const key = repo.rootUri.fsPath;
    this.repoSubs.get(key)?.dispose();
    this.repoSubs.delete(key);
  }

  /** The branch checked out in the repository that owns `root`. */
  readonly branchOf = (root: string): string | undefined => {
    const repos = this.api?.repositories ?? [];
    const owner = repoFor(repos.map((r) => r.rootUri.fsPath), root);
    const repo = owner === undefined ? undefined : repos.find((r) => r.rootUri.fsPath === owner);
    return repo ? branchName(repo) : undefined;
  };

  dispose(): void {
    this.disposed = true;
    for (const sub of [...this.subs, ...this.repoSubs.values()]) sub.dispose();
    this.subs.length = 0;
    this.repoSubs.clear();
  }
}

function branchName(repo: GitRepository): string | undefined {
  const head = repo.state.HEAD;
  return head && (head.type === undefined || head.type === 0) ? head.name || undefined : undefined;
}

/** What the grouped view depends on: the branch name and the commit it points at. */
function headKey(repo: GitRepository): string {
  return `${branchName(repo) ?? ""}@${repo.state.HEAD?.commit ?? ""}`;
}
