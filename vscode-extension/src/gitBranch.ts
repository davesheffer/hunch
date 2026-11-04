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
  state: { HEAD?: { name?: string; type?: number }; onDidChange: vscode.Event<void> };
}
interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
}

export class GitBranches implements vscode.Disposable {
  private api: GitApi | undefined;
  private readonly subs: vscode.Disposable[] = [];

  /** `onChange` fires when a repository opens or its checked-out branch changes. */
  constructor(private readonly onChange: () => void) {
    void this.connect();
  }

  private async connect(): Promise<void> {
    try {
      const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>("vscode.git");
      if (!ext) return;
      const exports = ext.isActive ? ext.exports : await ext.activate();
      const api = exports?.getAPI(1);
      if (!api) return;
      this.api = api;
      for (const repo of api.repositories) this.watch(repo);
      this.subs.push(api.onDidOpenRepository((repo) => { this.watch(repo); this.onChange(); }));
      if (api.repositories.length) this.onChange();
    } catch { /* Git extension unavailable: grouping falls back to HEAD */ }
  }

  private watch(repo: GitRepository): void {
    let last = branchName(repo);
    this.subs.push(repo.state.onDidChange(() => {
      const now = branchName(repo);
      if (now !== last) { last = now; this.onChange(); }
    }));
  }

  /** The branch checked out in the repository that owns `root`. */
  readonly branchOf = (root: string): string | undefined => {
    const repos = this.api?.repositories ?? [];
    const owner = repoFor(repos.map((r) => r.rootUri.fsPath), root);
    const repo = owner === undefined ? undefined : repos.find((r) => r.rootUri.fsPath === owner);
    return repo ? branchName(repo) : undefined;
  };

  dispose(): void {
    for (const sub of this.subs) sub.dispose();
    this.subs.length = 0;
  }
}

function branchName(repo: GitRepository): string | undefined {
  const head = repo.state.HEAD;
  return head && (head.type === undefined || head.type === 0) ? head.name || undefined : undefined;
}
