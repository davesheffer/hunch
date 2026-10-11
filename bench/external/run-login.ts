/**
 * Frontend-design bench: identical login-screen task, per model, two arms.
 *   arm A — bare model        (skills stripped, no MCP, CLAUDE.md hunch section stripped)
 *   arm F — skill + hunch     (frontend-design skill, hunch MCP, CLAUDE.md intact)
 *
 * Each cell: fresh hunch-repo worktree, one headless `claude -p` session, harvest
 * login-screen/index.html into bench/external/results/login/. No deterministic
 * pass/fail — outputs are compared visually + via a static checklist afterwards.
 *
 *   npx tsx bench/external/run-login.ts --models claude-haiku-4-5-20251001,claude-sonnet-5
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..");
const OUT_DIR = join(REPO, "bench", "external", "results", "login");

const argFlag = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const MODELS = argFlag("models", "claude-haiku-4-5-20251001,claude-sonnet-5,claude-opus-4-8,claude-fable-5").split(",");
const ARMS = argFlag("arms", "A,F").split(",") as Array<"A" | "F">;
const MAX_TURNS = Number(argFlag("max-turns", "40"));
// --force-skill: F-arm prompt names frontend-design explicitly — separates
// "skill content doesn't help" from "model never reads it" (login bench round 1:
// 2 of 4 F cells never invoked it). Outputs get an 'f' suffix, never clobber round 1.
const FORCE_SKILL = process.argv.includes("--force-skill");

const promptFor = (arm: "A" | "F"): string =>
  (FORCE_SKILL && arm === "F"
    ? `First invoke the frontend-design skill (Skill tool) and follow it strictly, grounding every design choice in this specific product.\n\n`
    : "") + PROMPT;

const PROMPT = [
  "Create a login screen for this product.",
  "",
  "Deliverable: a single self-contained file at login-screen/index.html — all CSS and JS inline,",
  "zero external requests (no CDN fonts, scripts, images, or icon sets).",
  "",
  "Style: basic but beautiful. Sexy, clean, modern, polished — not templated or generic.",
  "",
  "Requirements:",
  "- email + password fields, submit button, remember-me checkbox, forgot-password link",
  "- looks great on mobile and desktop; supports dark mode (prefers-color-scheme)",
  "- accessible: real labels, visible focus states, keyboard navigable, sensible autocomplete attributes",
  "",
  "When the file is written, reply with exactly: DONE",
].join("\n");

const sh = (cmd: string, cwd = REPO): string => execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const BASE = sh("git rev-parse HEAD").trim();

function makeWorktree(name: string, arm: "A" | "F"): string {
  const dir = join(tmpdir(), "login-bench", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(tmpdir(), "login-bench"), { recursive: true });
  try { sh(`git worktree prune`); } catch { /* best effort */ }
  sh(`git worktree add --force --detach "${dir}" ${BASE}`);

  if (arm === "A") {
    rmSync(join(dir, ".claude", "skills"), { recursive: true, force: true });
    const cm = join(dir, "CLAUDE.md");
    const text = readFileSync(cm, "utf8").replace(/## 🧠 Hunch[\s\S]*?_Hunch updates itself[^\n]*\n/, "");
    writeFileSync(cm, text);
  }
  if (arm === "F") {
    // frontend-design lives at user level; --setting-sources project excludes it, so copy it in
    const fd = join(homedir(), ".claude", "skills", "frontend-design");
    if (existsSync(fd)) cpSync(fd, join(dir, ".claude", "skills", "frontend-design"), { recursive: true, dereference: true });
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { hunch: { command: "npx", args: ["-y", "@davesheffer/hunch@latest", "mcp"] } } }, null, 2),
    );
  }
  return dir;
}

function dropWorktree(dir: string): void {
  try { sh(`git worktree remove --force "${dir}"`); } catch { /* git worktree prune later */ }
  rmSync(dir, { recursive: true, force: true });
}

function runClaude(dir: string, model: string, arm: "A" | "F"): { numTurns: number; durationMs: number; result: string } {
  const t0 = Date.now();
  const mcp = existsSync(join(dir, ".mcp.json")) ? ` --mcp-config .mcp.json` : "";
  const cmd = `claude -p --model ${model} --output-format json --permission-mode bypassPermissions --max-turns ${MAX_TURNS} --setting-sources project${mcp} --strict-mcp-config`;
  let out = "";
  try {
    out = execSync(cmd, { cwd: dir, input: promptFor(arm), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000 });
  } catch (e) { out = String((e as { stdout?: string }).stdout ?? ""); }
  let parsed: { result?: string; num_turns?: number } = {};
  try { parsed = JSON.parse(out); } catch { parsed = { result: out }; }
  return { numTurns: parsed.num_turns ?? -1, durationMs: Date.now() - t0, result: parsed.result ?? "" };
}

// ------------------------------------------------------------------- main
console.log(`login bench: models=${MODELS.join(",")} arms=${ARMS.join(",")}${FORCE_SKILL ? " (forced skill)" : ""}`);
mkdirSync(OUT_DIR, { recursive: true });
const metaPath = join(OUT_DIR, "meta.json");
const rows: Array<Record<string, unknown>> = existsSync(metaPath)
  ? (JSON.parse(readFileSync(metaPath, "utf8")) as Array<Record<string, unknown>>)
  : [];

for (const model of MODELS) {
  for (const arm of ARMS) {
    const slug = `${model.replace(/[^a-z0-9]/gi, "")}-${arm}${FORCE_SKILL && arm === "F" ? "f" : ""}`;
    process.stdout.write(`▶ ${slug} … `);
    const dir = makeWorktree(slug, arm);
    try {
      const run = runClaude(dir, model, arm);
      const html = join(dir, "login-screen", "index.html");
      const ok = existsSync(html);
      if (ok) cpSync(html, join(OUT_DIR, `${slug}.html`));
      rows.push({ model, arm, slug, forced: FORCE_SKILL && arm === "F", produced: ok, bytes: ok ? readFileSync(html, "utf8").length : 0, turns: run.numTurns, durationMs: run.durationMs });
      console.log(`${ok ? "OK" : "NO FILE"}  ${run.numTurns} turns, ${(run.durationMs / 1000).toFixed(0)}s${ok ? "" : ` — tail: ${run.result.slice(-200)}`}`);
    } finally { dropWorktree(dir); }
    writeFileSync(join(OUT_DIR, "meta.json"), JSON.stringify(rows, null, 2));
  }
}
console.log(`\ndone. outputs: bench/external/results/login/`);
