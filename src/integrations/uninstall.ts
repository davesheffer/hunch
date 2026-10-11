/**
 * `hunch uninstall` (#449): remove exactly what Hunch installed in a repository
 * and leave an opt-out marker so nothing re-installs it.
 *
 * Planning is read-only and complete before anything is written: every file is
 * parsed first, and one that cannot be parsed (or whose Hunch markers are
 * damaged) is refused, so a run either changes nothing or applies the whole plan
 * (con_8460b6770f). Each step removes only Hunch's own part of a file — the
 * marker-delimited block, the `hunch` server entry, the hook commands the
 * installers' own classifiers call ours — and a file is deleted only when
 * nothing but Hunch's part was in it. Running it twice is a no-op.
 *
 * `.hunch/` holds the engineering memory, so it stays unless `--purge`.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, relative } from "node:path";
import { parse as parseToml } from "smol-toml";
import { writeFileAtomic } from "../core/io.js";
import { gitCommonDir, isGitRepo, separateGitDirLink } from "../extractors/git.js";
import { HUNCH_END, HUNCH_START } from "./claudemd.js";
import { ciWorkflowYaml } from "./ciAction.js";
import { assertSafeTopLevelConfigFile, stripManagedGitignore } from "./gitignore.js";
import { isHunchHookCommand } from "./hookmatch.js";
import { planHookRemoval } from "./hooks.js";
import { ATTR_LINES, targetRepositoryEnv } from "./mergeDriver.js";
import { antigravityMcpFile, isHunchProviderHook, readJsonObj, TOML_END, TOML_START, windsurfMcpFile } from "./providers.js";
import { SLASH_COMMAND_FILES } from "./scaffold.js";

/** The opt-out marker, at the repository root. Commit it so every clone stays opted out. */
export const OPT_OUT_FILE = ".hunch-removed";

export function isOptedOut(root: string): boolean {
  try { return lstatSync(join(root, OPT_OUT_FILE)).isFile(); } catch { return false; }
}

export function optOutMessage(): string {
  return `Hunch was removed from this repository on purpose (${OPT_OUT_FILE}), so it will not set itself up here again. To reinstall, delete ${OPT_OUT_FILE} and run \`hunch init\`.`;
}

function markerText(): string {
  return [
    `Hunch was removed from this repository on purpose (\`hunch uninstall\`, ${new Date().toISOString().slice(0, 10)}).`,
    "",
    "While this file exists, Hunch commands refuse to set Hunch up here again.",
    "Coding agents: do not re-install Hunch or re-add its MCP server, hooks or",
    "instruction blocks in this repository.",
    "",
    "To reinstall Hunch, delete this file and run `hunch init`.",
    "",
  ].join("\n");
}

export interface UninstallStep {
  /** Repo-relative (POSIX) where possible, else absolute. */
  path: string;
  kind: "edit" | "delete" | "create" | "keep";
  note: string;
  run?: () => void;
}

export interface UninstallPlan {
  root: string;
  purge: boolean;
  steps: UninstallStep[];
  refused: Array<{ path: string; reason: string }>;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** A delete step's note: the file held nothing but Hunch's part. */
const deleted = (note: string): string => `${note.replace(/ \(.*\)$/, "")}; nothing else was in the file`;

/** Join the text around a removed block, dropping the blank lines the writer added. */
function joinAround(before: string, after: string, eol: string): string {
  const b = before.replace(/\s+$/, "");
  const a = after.replace(/^[ \t]*\r?\n/, "").replace(/^\s+/, "");
  if (!a) return b ? `${b}${eol}` : "";
  return b ? `${b}${eol}${eol}${a}` : a;
}

class Planner {
  readonly steps: UninstallStep[] = [];
  readonly refused: Array<{ path: string; reason: string }> = [];
  constructor(readonly root: string) {}

  rel(abs: string): string {
    const r = relative(this.root, abs);
    return r && !r.startsWith("..") ? r.replace(/\\/g, "/") : abs;
  }

  text(rel: string): string | null {
    const file = join(this.root, rel);
    try { return statSync(file).isFile() ? readFileSync(file, "utf8") : null; } catch { return null; }
  }

  writeOrDelete(rel: string, next: string, deleteWhenEmpty: boolean, note: string): void {
    const file = join(this.root, rel);
    if (deleteWhenEmpty && next.trim() === "") {
      this.steps.push({ path: rel, kind: "delete", note: deleted(note), run: () => rmSync(file, { force: true }) });
    } else {
      this.steps.push({ path: rel, kind: "edit", note, run: () => writeFileAtomic(file, next) });
    }
  }

  /** Parse a JSON config with the writers' own strictness, let `mutate` take Hunch's
   *  part out, then rewrite it — or delete it when only Hunch's part was there. */
  json(rel: string, note: string, mutate: (json: Json) => boolean, empty: (json: Json) => boolean = (j) => Object.keys(j).length === 0): void {
    const file = join(this.root, rel);
    if (!existsSync(file)) return;
    let json: Json;
    try { json = readJsonObj(file); } catch (e) { this.refused.push({ path: rel, reason: (e as Error).message }); return; }
    if (!mutate(json)) return;
    if (empty(json)) this.steps.push({ path: rel, kind: "delete", note: deleted(note), run: () => rmSync(file, { force: true }) });
    else this.steps.push({ path: rel, kind: "edit", note, run: () => writeFileAtomic(file, JSON.stringify(json, null, 2) + "\n") });
  }

  mcpEntry(rel: string, key: string): void {
    this.json(rel, "removed the hunch MCP server entry", (json) => {
      const servers = json[key];
      if (!isObj(servers) || !("hunch" in servers)) return false;
      delete servers.hunch;
      if (Object.keys(servers).length === 0) delete json[key];
      return true;
    });
  }

  /** Hunch commands in a `{ hooks: { Event: [...] } }` file. */
  hookConfig(rel: string, isOurs: (entry: unknown) => unknown, empty?: (json: Json) => boolean): void {
    this.json(rel, "removed Hunch's hook commands", (json) => {
      const hooks = json.hooks;
      if (!isObj(hooks)) return false;
      let changed = false;
      for (const [event, list] of Object.entries(hooks)) {
        if (!Array.isArray(list)) continue;
        const kept = list.map(isOurs).filter((e) => e !== null);
        if (kept.length === list.length && kept.every((e, i) => e === list[i])) continue;
        changed = true;
        if (kept.length) hooks[event] = kept;
        else delete hooks[event];
      }
      if (changed && Object.keys(hooks).length === 0) delete json.hooks;
      return changed;
    }, empty);
  }

  /** A marker-delimited block in a text file. */
  block(rel: string, start: string, end: string, note: string, isEmpty: (rest: string) => boolean, validate?: (text: string) => string | null): void {
    const cur = this.text(rel);
    if (cur === null || (!cur.includes(start) && !cur.includes(end))) return;
    const i = cur.indexOf(start);
    const j = cur.indexOf(end);
    if (i < 0 || j < i) {
      this.refused.push({ path: rel, reason: `its Hunch block markers are damaged (${start.slice(0, 24)}… / ${end}); remove the block by hand, then re-run` });
      return;
    }
    const problem = validate?.(cur);
    if (problem) { this.refused.push({ path: rel, reason: problem }); return; }
    const eol = cur.includes("\r\n") ? "\r\n" : "\n";
    const next = joinAround(cur.slice(0, i), cur.slice(j + end.length), eol);
    const file = join(this.root, rel);
    if (isEmpty(next)) this.steps.push({ path: rel, kind: "delete", note: deleted(note), run: () => rmSync(file, { force: true }) });
    else this.steps.push({ path: rel, kind: "edit", note, run: () => writeFileAtomic(file, next) });
  }
}

/** Claude Code's settings.json: Hunch's commands inside each matcher entry. */
function claudeEntry(entry: unknown): unknown {
  if (!isObj(entry) || !Array.isArray(entry.hooks)) return entry;
  const hooks = entry.hooks as unknown[];
  const kept = hooks.filter((h) => !(isObj(h) && typeof h.command === "string" && isHunchHookCommand(h.command, false)));
  if (kept.length === hooks.length) return entry;
  return kept.length ? { ...entry, hooks: kept } : null;
}

const providerEntry = (entry: unknown): unknown => (isHunchProviderHook(entry) ? null : entry);

function normalizedCi(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/@davesheffer\/hunch@\S+/g, "@davesheffer/hunch@<version>");
}

function gitConfigHasDrivers(root: string): boolean {
  const r = spawnSync("git", ["config", "--local", "--get-regexp", "^merge\\.hunch(-grounding)?\\."], { cwd: root, env: targetRepositoryEnv(), encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() !== "";
}

/** The overlay clone a pointer names, for the "kept" note. Never deleted: it is
 *  its own repository holding memory that may not be pushed yet. */
function pointerOverlay(file: string): string | null {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as { privateDir?: unknown };
    return typeof v.privateDir === "string" ? v.privateDir : null;
  } catch { return null; }
}

/** Read-only: everything `hunch uninstall` would do in `root`. */
export function planUninstall(root: string, opts: { purge?: boolean } = {}): UninstallPlan {
  const purge = !!opts.purge;
  const p = new Planner(root);

  if (!isOptedOut(root)) {
    const file = join(root, OPT_OUT_FILE);
    p.steps.push({ path: OPT_OUT_FILE, kind: "create", note: "opt-out marker: Hunch will not set itself up here again (commit it so every clone stays opted out)", run: () => writeFileAtomic(file, markerText()) });
  }

  // Grounding docs. Shared docs keep the user's prose; a doc left holding only the
  // title Hunch gave it when it created the file goes entirely.
  const shared: Array<[string, string]> = [
    ["CLAUDE.md", `# ${basename(root)}`],
    ["AGENTS.md", "# AGENTS.md"],
    [".github/copilot-instructions.md", "# Copilot instructions"],
  ];
  for (const [rel, title] of shared) {
    p.block(rel, HUNCH_START, HUNCH_END, "removed the Hunch instruction block (your own text is kept)", (rest) => rest.trim() === "" || rest.trim() === title);
  }
  for (const rel of [".cursor/rules/hunch.mdc", ".windsurf/rules/hunch.md"]) {
    const cur = p.text(rel);
    if (cur === null) continue;
    if (cur.includes(HUNCH_START)) p.steps.push({ path: rel, kind: "delete", note: "Hunch's rule file", run: () => rmSync(join(root, rel), { force: true }) });
    else p.steps.push({ path: rel, kind: "keep", note: "no Hunch block in it any more, so it is yours; delete it yourself if you don't want it" });
  }

  // MCP registrations.
  p.mcpEntry(".mcp.json", "mcpServers");
  p.mcpEntry(".cursor/mcp.json", "mcpServers");
  p.mcpEntry(".vscode/mcp.json", "servers");
  p.mcpEntry(".windsurf/mcp_config.json", "mcpServers");
  p.mcpEntry(".agents/mcp_config.json", "mcpServers");
  // Global (per-user) registrations `init` adds when the host is installed: shared by
  // every repository on this machine, so never edited here — reported, so the user
  // knows the entry remains (it is inert in this repository: `hunch mcp` refuses).
  for (const [file, host] of [[windsurfMcpFile(), "Windsurf"], [antigravityMcpFile(), "Antigravity"]] as const) {
    if (!file) continue;
    try {
      const servers = (readJsonObj(file) as { mcpServers?: unknown }).mcpServers;
      if (isObj(servers) && "hunch" in servers) p.steps.push({ path: file, kind: "keep", note: `${host}'s global hunch MCP entry serves every repository on this machine; remove it there if you want Hunch gone everywhere` });
    } catch { /* unreadable global config: nothing to report about it here */ }
  }
  p.block(".codex/config.toml", TOML_START, TOML_END, "removed the managed hunch MCP block", (rest) => rest.trim() === "", (text) => {
    try { parseToml(text); return null; } catch (e) { return `refusing to edit: could not parse TOML (${(e as Error).message}); fix it, then re-run`; }
  });

  // Agent lifecycle hooks.
  p.hookConfig(".claude/settings.json", claudeEntry);
  p.hookConfig(".cursor/hooks.json", providerEntry, (j) => Object.keys(j).every((k) => k === "version"));
  p.hookConfig(".codex/hooks.json", providerEntry);
  p.hookConfig(".github/hooks/hunch.json", providerEntry);
  p.hookConfig(".windsurf/hooks.json", providerEntry);
  p.json(".agents/hooks.json", "removed the hunch hook group", (json) => {
    if (!("hunch" in json)) return false;
    delete json.hunch;
    return true;
  });

  // Generated slash commands: only files carrying the ownership marker, or in the
  // hunch- namespace the writer always treats as its own.
  for (const name of SLASH_COMMAND_FILES) {
    const rel = `.claude/commands/${name}`;
    const cur = p.text(rel);
    if (cur === null) continue;
    if (name.startsWith("hunch-") || cur.includes("hunch:generated")) {
      p.steps.push({ path: rel, kind: "delete", note: "generated slash command", run: () => rmSync(join(root, rel), { force: true }) });
    }
  }

  // CI workflow, only when it is still the file Hunch generated.
  const ciRel = ".github/workflows/hunch-guard.yml";
  const ci = p.text(ciRel);
  if (ci !== null) {
    if (normalizedCi(ci) === normalizedCi(ciWorkflowYaml())) {
      p.steps.push({ path: ciRel, kind: "delete", note: "the Hunch Guard CI workflow", run: () => rmSync(join(root, ciRel), { force: true }) });
    } else {
      p.steps.push({ path: ciRel, kind: "keep", note: "it differs from the workflow Hunch generates (edited?); delete it yourself if you no longer want the Hunch Guard check" });
    }
  }

  // Git hooks + merge driver.
  if (isGitRepo(root)) {
    for (const h of planHookRemoval(root)) {
      const path = p.rel(h.path);
      if (h.reason) p.steps.push({ path, kind: "keep", note: h.reason });
      else if (h.next === null) p.steps.push({ path, kind: "delete", note: `Hunch's ${h.hookName} git hook`, run: () => rmSync(h.path, { force: true }) });
      else {
        const next = h.next!;
        p.steps.push({ path, kind: "edit", note: `removed Hunch's block from the ${h.hookName} git hook (your own lines are kept)`, run: () => { writeFileSync(h.path, next); chmodSync(h.path, 0o755); } });
      }
    }
    if (gitConfigHasDrivers(root)) {
      p.steps.push({
        path: ".git/config", kind: "edit", note: "unregistered the merge.hunch and merge.hunch-grounding drivers",
        run: () => {
          for (const section of ["merge.hunch", "merge.hunch-grounding"]) {
            spawnSync("git", ["config", "--local", "--remove-section", section], { cwd: root, env: targetRepositoryEnv(), stdio: "ignore" });
          }
        },
      });
    }
  }
  const attrs = p.text(".gitattributes");
  if (attrs !== null) {
    try {
      assertSafeTopLevelConfigFile(root, ".gitattributes");
      const ours = new Set(ATTR_LINES);
      const lines = attrs.split("\n");
      const kept = lines.filter((l) => !ours.has(l.trim()));
      if (kept.length !== lines.length) p.writeOrDelete(".gitattributes", kept.join("\n"), true, "removed Hunch's merge-driver routes");
    } catch (e) {
      p.refused.push({ path: ".gitattributes", reason: (e as Error).message });
    }
  }

  // Memory and its wiring.
  const hunchDir = join(root, ".hunch");
  const localPointer = join(hunchDir, "local.json");
  const common = isGitRepo(root) ? gitCommonDir(root) : "";
  const commonPointer = common ? join(common, "hunch", "local.json") : "";
  const overlays = new Set([localPointer, commonPointer].filter((f) => f && existsSync(f)).map(pointerOverlay).filter((d): d is string => !!d));
  const inRepoOverlay = existsSync(join(root, ".hunch-private"));
  if (!purge) {
    if (existsSync(hunchDir)) p.steps.push({ path: ".hunch/", kind: "keep", note: "your engineering memory; `hunch uninstall --purge` deletes it" });
  } else {
    const gi = p.text(".gitignore");
    if (gi !== null) {
      try {
        assertSafeTopLevelConfigFile(root, ".gitignore");
        const { next, damaged } = stripManagedGitignore(gi);
        if (damaged) p.refused.push({ path: ".gitignore", reason: "a Hunch block has no closing marker; remove it by hand, then re-run" });
        else if (next !== gi) {
          if (inRepoOverlay) p.steps.push({ path: ".gitignore", kind: "keep", note: "its Hunch block still ignores the .hunch-private/ overlay clone; delete that clone yourself (after pushing it), then re-run `hunch uninstall --purge`" });
          else p.writeOrDelete(".gitignore", next, true, "removed Hunch's ignore blocks");
        }
      } catch (e) {
        p.refused.push({ path: ".gitignore", reason: (e as Error).message });
      }
    }
    if (existsSync(hunchDir)) p.steps.push({ path: ".hunch/", kind: "delete", note: "engineering memory, config and derived index (--purge)", run: () => rmSync(hunchDir, { recursive: true, force: true }) });
    const cache = join(root, ".hunch-cache");
    if (existsSync(cache)) p.steps.push({ path: ".hunch-cache/", kind: "delete", note: "derived cache", run: () => rmSync(cache, { recursive: true, force: true }) });
    if (common) {
      for (const file of [commonPointer, separateGitDirLink(common)]) {
        if (existsSync(file)) p.steps.push({ path: p.rel(file), kind: "delete", note: "this clone's Hunch pointer in the git dir", run: () => rmSync(file, { force: true }) });
      }
    }
  }
  for (const dir of overlays) {
    p.steps.push({ path: p.rel(dir), kind: "keep", note: "a private/shared overlay clone: its own repository with memory that may not be pushed; never deleted here" });
  }
  return { root, purge, steps: p.steps, refused: p.refused };
}

/** Directories Hunch's writers create; removed only when left empty. Deepest first. */
const PRUNE_DIRS = [
  ".claude/commands", ".claude", ".cursor/rules", ".cursor", ".windsurf/rules", ".windsurf",
  ".vscode", ".github/hooks", ".github/workflows", ".github", ".codex", ".agents",
];

/** Apply a plan with no refusals. The opt-out marker goes first, so an interrupted
 *  run is already opted out. A step that fails at write time (a file held open by a
 *  running `hunch mcp`/`hunch serve` on Windows, a permission) does not stop the
 *  others; the failures are returned so the caller can say what is left and that a
 *  re-run — idempotent — finishes the job. */
/** What applyUninstall actually did: the steps that ran (so output never
 *  claims a step that was skipped), and the ones that failed. */
export interface UninstallResult {
  applied: UninstallStep[];
  failed: Array<{ path: string; error: string }>;
}

export function applyUninstall(plan: UninstallPlan): UninstallResult {
  if (plan.refused.length) throw new Error("refusing to apply an uninstall plan that has refusals");
  const applied: UninstallStep[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const step of plan.steps) {
    try { step.run?.(); applied.push(step); } catch (e) {
      failed.push({ path: step.path, error: (e as Error).message });
      if (step.path === OPT_OUT_FILE) return { applied, failed }; // never strip Hunch without the marker that keeps it out
    }
  }
  for (const rel of PRUNE_DIRS) {
    const dir = join(plan.root, rel);
    try { if (readdirSync(dir).length === 0) rmdirSync(dir); } catch { /* absent or not empty */ }
  }
  if (plan.purge) {
    const common = isGitRepo(plan.root) ? gitCommonDir(plan.root) : "";
    if (common) {
      const dir = join(common, "hunch");
      try { if (readdirSync(dir).length === 0) rmdirSync(dir); } catch { /* absent or not empty */ }
    }
  }
  return { applied, failed };
}

export function formatUninstallPlan(plan: UninstallPlan, dryRun: boolean): string[] {
  const verb = (k: UninstallStep["kind"]): string => ({ edit: dryRun ? "would edit" : "edited", delete: dryRun ? "would delete" : "deleted", create: dryRun ? "would create" : "created", keep: "kept" })[k];
  const icon = (k: UninstallStep["kind"]): string => (k === "keep" ? "·" : "✓");
  const out: string[] = [];
  for (const r of plan.refused) out.push(`  ✗ ${r.path}: ${r.reason}`);
  for (const s of plan.steps) out.push(`  ${icon(s.kind)} ${verb(s.kind)} ${s.path} — ${s.note}`);
  return out;
}
