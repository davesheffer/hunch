import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanupDir, isolatedCliEnv, tempDir } from "./fixtures.js";
import { hunchCliArgs } from "./cli-invocation.js";
import { OPT_OUT_FILE } from "../src/integrations/uninstall.js";

/** #458 bug class: the opt-out gate (#449) and every option naming a location were
 *  built separately and only ever judged the cwd, so `--root`/`--config` slipped past
 *  it. This matrix DISCOVERS every command and every location-taking option from the
 *  live Commander tree and runs each against the gate in both directions. A location
 *  option added later fails the inventory test until it is classified below — new
 *  options cannot silently bypass the gate. */

type Kind =
  /** names the repository/store the command acts on: it, not the cwd, decides the gate */
  | "root"
  /** a path the command writes to: an opted-out repository must never receive it */
  | "output"
  /** a file or directory the command only reads: the cwd's repository decides the gate */
  | "input"
  /** an output path the command itself confines to the cwd's repository (repo-relative only) */
  | "confined"
  /** an OPT_OUT_ALLOWED command (merge drivers): never gated */
  | "exempt";

/** Every location-taking option and positional, keyed "<command path> <flag|<arg>>". */
const EXPECTED: Record<string, Kind> = {
  "--cli-config": "input",
  "serve --config": "root",
  "serve replay --root": "root",
  "serve init --root": "root",
  "serve init --config": "root",
  "serve init --proof-key-file": "input",
  "state --token-file": "input",
  "state --proof-key-file": "input",
  "state read --input": "input",
  "state write --input": "input",
  "state records --input": "input",
  "state subscribe --input": "input",
  "review-memory auto --from": "input",
  "review-memory auto --cli-config": "input",
  "review-memory auto --output": "output",
  "review-memory prepare --from": "input",
  "review-memory capture --from": "input",
  "review-memory capture --rules": "input",
  "private --repo": "input",
  "private <dir>": "output",
  "shared --repo": "input",
  "shared <dir>": "output",
  "worktree <path>": "output",
  "eval --file": "input",
  "policy corpus --import": "input",
  "constitution scorecard <file>": "input",
  "constitution ingest --from": "input",
  "constitution g2 --plan": "input",
  "constitution g3 --experiment": "input",
  "constitution g3 --plan": "input",
  "constitution g3 --review": "input",
  "experiment validate <file>": "input",
  "experiment prepare <file>": "input",
  "experiment qualify <file>": "input",
  "experiment submit <file>": "input",
  "experiment respond --rule-file": "input",
  "experiment followup <file>": "input",
  "experiment stop <file>": "input",
  "import-adr <dir>": "input",
  "export-adr <dir>": "output",
  "mcp --root": "root",
  "footprint --target": "input",
  "verify --map": "output",
  "wiki --dir": "confined",
  "repair-ref --from": "input",
  "repair-ref --to": "input",
  "merge-driver <path>": "exempt",
  "merge-driver-grounding <path>": "exempt",
};

/** Cases that expose a real gate hole: the assertion stays, marked todo. */
const KNOWN_HOLES: Record<string, string> = {};

/** Location positionals named "path" that name a directory, not a file. */
const DIR_SHAPED = new Set(["worktree <path>"]);
/** Values that let a case get past argument validation to the code that touches the path. */
const FILL: Record<string, string> = { "--partition": "user:matrix", "--repository": "owner/repo" };

const OPT_OUT_TEXT = "was removed from this repository on purpose";
const LOCATION_WORDS = new Set(["root", "config", "dir", "out", "output", "repo", "path", "cwd", "file", "folder"]);
const LOCATION_PLACEHOLDER = /[<[](dir|file|files|path|paths|root|folder)(\.\.\.)?[>\]]/i;
const LOCATION_ARG = /^(dir|file|files|path|paths|root|folder)$/i;

interface DumpOption { long?: string; flags: string; mandatory: boolean; hasDefault: boolean; choices?: string[]; takesValue: boolean }
interface DumpArg { name: string; required: boolean; choices?: string[] }
interface DumpCommand { path: string[]; hasAction: boolean; options: DumpOption[]; args: DumpArg[]; subs: DumpCommand[] }

/** Load the real Commander tree in one process: stub parseAsync, import the CLI. */
const DUMP_SCRIPT = `
const [commanderUrl, cliUrl] = process.argv.slice(2);
const { Command } = await import(commanderUrl);
Command.prototype.parseAsync = async function () {
  const walk = (c, path) => ({
    path,
    hasAction: typeof c._actionHandler === "function",
    options: c.options.map((o) => ({ long: o.long, flags: o.flags, mandatory: !!o.mandatory, hasDefault: o.defaultValue !== undefined,
      choices: o.argChoices, takesValue: !!(o.required || o.optional) })),
    args: c.registeredArguments.map((a) => ({ name: a.name(), required: a.required, choices: a.argChoices })),
    subs: c.commands.map((s) => walk(s, [...path, s.name()])),
  });
  process.stdout.write(JSON.stringify(walk(this, [])));
  process.exit(0);
};
await import(cliUrl);
`;

interface Location { key: string; owner: DumpCommand; option?: DumpOption; arg?: DumpArg; fileShaped: boolean }

function discover(tree: DumpCommand): { commands: number; locations: Location[] } {
  const locations: Location[] = [];
  let commands = 0;
  const walk = (c: DumpCommand) => {
    commands++;
    const prefix = c.path.join(" ");
    for (const o of c.options) {
      if (!o.long || !o.takesValue) continue;
      const words = o.long.slice(2).split("-");
      if (words.some((w) => LOCATION_WORDS.has(w)) || LOCATION_PLACEHOLDER.test(o.flags)) {
        locations.push({ key: `${prefix} ${o.long}`.trim(), owner: c, option: o, fileShaped: !/<(dir|root|folder)/i.test(o.flags) });
      }
    }
    for (const a of c.args) {
      const key = `${prefix} <${a.name}>`;
      if (LOCATION_ARG.test(a.name)) locations.push({ key, owner: c, arg: a, fileShaped: !/^(dir|root|folder)$/i.test(a.name) && !DIR_SHAPED.has(key) });
    }
    c.subs.forEach(walk);
  };
  walk(tree);
  return { commands, locations };
}

function findCommand(tree: DumpCommand, path: string[]): DumpCommand {
  let c = tree;
  for (const name of path) c = c.subs.find((s) => s.path[s.path.length - 1] === name)!;
  return c;
}

/** The command that actually runs: the owner if it has an action, else its first runnable descendant. */
function hostOf(tree: DumpCommand, owner: DumpCommand): DumpCommand {
  if (owner.path.length === 0) return findCommand(tree, ["why"]);
  if (owner.hasAction) return owner;
  const queue = [...owner.subs];
  for (let c = queue.shift(); c; c = queue.shift()) { if (c.hasAction) return c; queue.push(...c.subs); }
  return owner;
}

/** Every file and directory under `dir`, relative — the opted-out repository's footprint. */
function snapshot(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    out.push(path);
    if (entry.isDirectory()) out.push(...snapshot(dir, path));
  }
  return out.sort();
}

interface RunResult { status: number | null; out: string; timedOut: boolean }

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RunResult> {
  return new Promise((done) => {
    // stdin closed: `mcp` sees EOF; servers that keep running are killed at the timeout.
    const child = spawn(process.execPath, hunchCliArgs(...args), { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let timedOut = false;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on("close", (status) => { clearTimeout(timer); done({ status, out, timedOut }); });
  });
}

function gitRepo(dir: string, env: NodeJS.ProcessEnv): void {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@test.invalid"); git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "fixture\n");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "keep.txt"), "keep\n");
  git("add", "-A"); git("commit", "-qm", "init");
}

interface Case { name: string; kind: Kind; scenario: "a" | "b"; args: string[]; cwd: "optout" | "clean"; host: string }

test("opt-out gate holds for every location-taking option of every command (#458 class)", { timeout: 600_000 }, async (t) => {
  const base = tempDir("hunch-optout-matrix-");
  try {
    const home = join(base, "home");
    mkdirSync(home);
    const env = isolatedCliEnv({
      HUNCH_PRIVATE_DIR: "", HUNCH_EMBEDDINGS: "off", HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"),
      XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1", HUNCH_SYNC: "1", NO_COLOR: "1", CI: "1",
      GIT_TERMINAL_PROMPT: "0",
    });

    // ---- discovery ---------------------------------------------------------------
    const dumpFile = join(base, "dump-tree.mjs");
    writeFileSync(dumpFile, DUMP_SCRIPT);
    const dump = spawnSync(process.execPath, [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), dumpFile,
      import.meta.resolve("commander"), pathToFileURL(join(process.cwd(), "src/cli/index.ts")).href],
    { cwd: home, env, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    assert.equal(dump.status, 0, `${dump.stdout}${dump.stderr}`);
    const tree = JSON.parse(dump.stdout) as DumpCommand;
    const { commands, locations } = discover(tree);
    assert.ok(commands > 100, `discovered the whole command tree (${commands})`);

    await t.test("every discovered location option is classified (and nothing classified vanished)", () => {
      assert.deepEqual(locations.map((l) => l.key).sort(), Object.keys(EXPECTED).sort(),
        "a location option was added or removed: classify it in EXPECTED so it cannot bypass the opt-out gate unnoticed");
    });

    // ---- fixtures ----------------------------------------------------------------
    const templates = join(base, "templates");
    const cleanTpl = join(templates, "clean");
    const optoutTpl = join(templates, "optout");
    gitRepo(cleanTpl, env);
    const init = spawnSync(process.execPath, hunchCliArgs("init", "--no-index"), { cwd: cleanTpl, env, encoding: "utf8", timeout: 180_000 });
    assert.equal(init.status, 0, `${init.stdout}${init.stderr}`);
    gitRepo(optoutTpl, env);
    writeFileSync(join(optoutTpl, OPT_OUT_FILE), "opted out\n");
    mkdirSync(join(optoutTpl, "nested", ".hunch"), { recursive: true });
    writeFileSync(join(optoutTpl, "nested", ".hunch", "partition.json"), JSON.stringify({ kind: "user", id: "nested" }) + "\n");

    /** Path of `shape` inside repo `r`: the dir itself for a root dir, a fresh leaf otherwise. */
    const target = (r: string, where: "root" | "sub" | "store", loc: Location, kind: Kind): string => {
      const dir = where === "root" ? r : where === "sub" ? join(r, "sub") : join(r, "nested");
      if (loc.fileShaped) return where === "store" ? join(r, "nested", ".hunch", "target.json") : join(dir, "target.json");
      return kind === "root" ? dir : join(dir, "out");
    };

    // ---- cases -------------------------------------------------------------------
    const cases: Case[] = [];
    let caseNo = 0;
    for (const loc of locations) {
      const kind = EXPECTED[loc.key];
      if (!kind || kind === "exempt") continue;
      const host = hostOf(tree, loc.owner);
      const scenarios: Array<["a" | "b", "root" | "sub" | "store"]> = [["a", "root"], ["b", "root"], ["b", "sub"], ["b", "store"]];
      for (const [scenario, where] of scenarios) {
        const dir = join(base, `case-${++caseNo}`);
        const optout = join(dir, "optout");
        const clean = join(dir, "clean");
        const value = target(scenario === "a" ? clean : optout, where, loc, kind);
        // Every OTHER location option of the host chain points at the clean repository, so
        // the case isolates this one option: (a) only the cwd is opted out, (b) only it is.
        const cleanFor = (other: Location) => target(clean, "root", other, EXPECTED[other.key] ?? "input");
        const args: string[] = [];
        const levels = [tree, ...host.path.map((_, i) => findCommand(tree, host.path.slice(0, i + 1)))];
        for (const level of levels) {
          if (level !== tree) args.push(level.path[level.path.length - 1]!);
          for (const o of level.options) {
            if (!o.long || !o.takesValue) continue;
            if (o === loc.option) { args.push(o.long, value); continue; }
            const other = locations.find((l) => l.option === o);
            if (other && kind === "root" && EXPECTED[other.key] === "root" && scenario === "a" && level === loc.owner) args.push(o.long, cleanFor(other));
            else if (o.mandatory && !o.hasDefault) args.push(o.long, other ? cleanFor(other) : FILL[o.long] ?? o.choices?.[0] ?? "x");
          }
        }
        let argsNeeded = host.args.length;
        if (loc.arg) argsNeeded = host.args.indexOf(loc.arg) + 1;
        else while (argsNeeded > 0 && !host.args[argsNeeded - 1]!.required) argsNeeded--;
        for (const a of host.args.slice(0, argsNeeded)) args.push(a === loc.arg ? value : a.choices?.[0] ?? "x");
        cases.push({ name: `${loc.key} (${kind}) ${scenario === "a" ? "a: cwd opted out, option -> clean repo" : `b: cwd clean, option -> opted-out ${where}`}`,
          kind, scenario, args, cwd: scenario === "a" ? "optout" : "clean", host: host.path[0] ?? "" });
        cpSync(cleanTpl, clean, { recursive: true });
        cpSync(optoutTpl, optout, { recursive: true });
      }
    }

    const results = new Map<string, { result: RunResult; before: string[]; after: string[] }>();
    const queue = cases.map((c, i) => ({ c, dir: join(base, `case-${i + 1}`) }));
    await Promise.all(Array.from({ length: 8 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const optout = join(job.dir, "optout");
        const before = snapshot(optout);
        const result = await runCli(job.c.args, join(job.dir, job.c.cwd), env, 40_000);
        results.set(job.c.name, { result, before, after: snapshot(optout) });
      }
    }));

    for (const c of cases) {
      const { result, before, after } = results.get(c.name)!;
      const detail = `hunch ${c.args.join(" ")}\n(exit ${result.status}${result.timedOut ? ", killed at timeout" : ""})\n${result.out.slice(0, 1500)}`;
      const refused = result.out.includes(OPT_OUT_TEXT);
      await t.test(c.name, KNOWN_HOLES[c.name] ? { todo: KNOWN_HOLES[c.name] } : {}, () => {
        if (c.scenario === "a") {
          if (c.kind === "root") assert.ok(!refused, `refused although the option names a clean repository:\n${detail}`);
          // Inputs and outputs do not choose the repository: the opted-out cwd still decides.
          else assert.ok(refused,`not refused in an opted-out cwd:\n${detail}`);
        } else {
          if (c.kind === "root" || c.kind === "output") assert.ok(refused, `not refused although the option points into an opted-out repository:\n${detail}`);
          assert.deepEqual(after, before, `wrote inside the opted-out repository:\n${detail}`);
        }
      });
    }
    assert.ok(cases.length >= 4 * Object.values(EXPECTED).filter((k) => k !== "exempt").length);
    assert.ok(existsSync(base));
  } finally {
    cleanupDir(base);
  }
});
