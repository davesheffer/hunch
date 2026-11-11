---
description: Which worktrees and branches are open on which machine, what is merged and deletable — from Hunch's workspace ledger, not from git spelunking
---
Answer **$ARGUMENTS** (default: "what is open, and what can I delete?") from the workspace ledger.

1. Call `hunch_workspaces(view: "branches")` (and `view: "inventory"` for the worktree list). Do NOT run `git branch`, `git worktree list` or `git log` yourself — the tool already read this machine live and every other machine from memory.
2. Report the rows as they are: MACHINES, WORKTREE (dirty), UPSTREAM, MERGED (with its method) and the ACTION column. A verdict of `unknown` or a machine marked `unverified` is reported as such, never upgraded to a guess.
3. Recommend only what the ACTION column says. You never delete a branch or remove a worktree from this command; the human runs the printed git commands (or `hunch workspaces prune` when it ships) on the machine that holds them.
4. If a machine is missing or stale, say so: it has not run `hunch workspaces snapshot` (the post-checkout hook / MCP session start does this) or it is not sharing an overlay.

<!-- hunch:generated — refreshed by hunch init; delete this line to take ownership -->
