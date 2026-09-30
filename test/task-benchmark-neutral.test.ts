import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchmarkGit, benchmarkGitText } from "../src/benchmark/memorySnapshot.js";
import { armConfinement, isInsidePath, readOauthTokenFile, removePreflightUserLineDirs, writeRepoChangesPatch, type ConfinementRoots } from "../src/benchmark/orchestrate.js";
import {
  distinctiveLine, leakedChildEnvKeys, neutralChildEnv, parseCanaryReply, preflight, REDACTED_TOKEN, redactText,
  redactTokenInDir, resultText, splitProbeLine, strippedChildEnv,
} from "../src/benchmark/taskRunner.js";

const TOKEN = "sk-ant-oat01-FIXTURE0123456789abcdefTOKEN";
const tempDir = () => mkdtempSync(join(tmpdir(), "hunch-task-benchmark-neutral-"));
const line = (value: unknown) => JSON.stringify(value);

/** A temp dir outside every git work tree (a machine's TMPDIR can itself sit inside one); null when there is none. */
export function gitFreeTempDir(prefix = "hunch-task-benchmark-neutral-"): string | null {
  for (const base of [tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])]) {
    const dir = mkdtempSync(join(base, prefix));
    if (benchmarkGit(["-C", dir, "rev-parse", "--show-toplevel"], { allowFailure: true }).status !== 0) return dir;
    rmSync(dir, { recursive: true, force: true });
  }
  return null;
}

test("neutral env: the parent's config dir and token are stripped, only the harness-set values pass the leak check", () => {
  const base = {
    PATH: "/bin", CLAUDE_CONFIG_DIR: "/home/x/.claude", CLAUDE_CODE_OAUTH_TOKEN: "parent-token", claude_code_oauth_token: "lower",
    CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_API_KEY: "sk-api",
  };
  const harness = neutralChildEnv("/run/claude-config", TOKEN);
  const env = strippedChildEnv(base, harness);
  assert.equal(env.CLAUDE_CONFIG_DIR, "/run/claude-config");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.equal(env.claude_code_oauth_token, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(leakedChildEnvKeys(env, harness), []);
  // Without the harness values those keys are leaks; a different value or another CLAUDE_* key still leaks.
  assert.deepEqual(leakedChildEnvKeys(env).sort(), ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"]);
  assert.deepEqual(leakedChildEnvKeys({ ...env, CLAUDE_CONFIG_DIR: "/home/x/.claude" }, harness), ["CLAUDE_CONFIG_DIR"]);
  assert.deepEqual(leakedChildEnvKeys({ ...env, CLAUDE_CODE_ENTRYPOINT: "cli" }, harness), ["CLAUDE_CODE_ENTRYPOINT"]);
  assert.deepEqual(leakedChildEnvKeys({ ...env, ANTHROPIC_API_KEY: TOKEN }, harness), ["ANTHROPIC_API_KEY"]);
  // Case-insensitive key compare (Windows): a lower-cased key with the harness value is the same key.
  assert.deepEqual(leakedChildEnvKeys({ PATH: "/bin", claude_config_dir: "/run/claude-config" }, harness), []);
  // Inherited mode: no harness values, the check is the version 1 check.
  assert.deepEqual(leakedChildEnvKeys(strippedChildEnv(base)), []);
});

test("readOauthTokenFile validates location and content and never echoes the token or path", (t) => {
  const dir = gitFreeTempDir();
  if (dir === null) { t.skip("no temp dir outside a git work tree"); return; }
  const errorOf = (fn: () => unknown): string => {
    try { fn(); } catch (error) { return (error as Error).message; }
    assert.fail("expected a refusal");
  };
  try {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    const good = join(outside, "token.txt");
    writeFileSync(good, `  ${TOKEN}\n`);
    assert.equal(readOauthTokenFile(good, [join(dir, "source"), null]), TOKEN);

    const repo = join(dir, "repo");
    mkdirSync(join(repo, "nested"), { recursive: true });
    execFileSync("git", ["init", "-q", repo], { windowsHide: true });
    const inRepo = join(repo, "nested", "token.txt");
    writeFileSync(inRepo, TOKEN);
    const multi = join(outside, "multi.txt");
    writeFileSync(multi, `${TOKEN}\nsecond-line\n`);
    const spaced = join(outside, "spaced.txt");
    writeFileSync(spaced, `${TOKEN} ${TOKEN}`);
    const empty = join(outside, "empty.txt");
    writeFileSync(empty, " \n");
    const quoted = join(outside, "quoted.txt");
    writeFileSync(quoted, `${TOKEN}"\\x`);

    const refusals: Array<[string, RegExp]> = [
      [errorOf(() => readOauthTokenFile(inRepo, [])), /inside a git work tree/],
      [errorOf(() => readOauthTokenFile(good, [outside])), /under a benchmark root/],
      [errorOf(() => readOauthTokenFile(good, [dir])), /under a benchmark root/],
      [errorOf(() => readOauthTokenFile(multi, [])), /single token on one line/],
      [errorOf(() => readOauthTokenFile(spaced, [])), /single token on one line/],
      [errorOf(() => readOauthTokenFile(empty, [])), /is empty/],
      [errorOf(() => readOauthTokenFile(quoted, [])), /letters, digits/],
      [errorOf(() => readOauthTokenFile("token.txt", [])), /absolute path/],
      [errorOf(() => readOauthTokenFile(join(outside, "missing.txt"), [])), /existing, accessible file/],
    ];
    for (const [message, pattern] of refusals) {
      assert.match(message, pattern);
      assert.ok(!message.includes(TOKEN) && !message.includes("second-line"), `no token in: ${message}`);
      assert.ok(!message.includes(dir) && !message.includes("token.txt"), `no path in: ${message}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redactTokenInDir replaces every occurrence in place, counts them, and does not follow symlinks", () => {
  const dir = tempDir();
  try {
    const run = join(dir, "run");
    mkdirSync(join(run, "repo", "deep"), { recursive: true });
    writeFileSync(join(run, "transcript.jsonl"), line({ type: "user", text: `env: CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}; again ${TOKEN}` }) + "\n");
    writeFileSync(join(run, "repo", "deep", "echo.txt"), TOKEN);
    writeFileSync(join(run, "clean.txt"), "nothing here\n");
    const binary = Buffer.concat([Buffer.from([0xff, 0x00, 0xfe]), Buffer.from(TOKEN), Buffer.from([0x80])]);
    writeFileSync(join(run, "blob.bin"), binary);
    const outsideFile = join(dir, "outside.txt");
    writeFileSync(outsideFile, TOKEN);
    let linked = true;
    try { symlinkSync(outsideFile, join(run, "link.txt")); } catch { linked = false; }

    assert.deepEqual(redactTokenInDir(run, TOKEN), { count: 4, failures: [] });
    assert.equal(readFileSync(join(run, "repo", "deep", "echo.txt"), "utf8"), REDACTED_TOKEN);
    assert.match(readFileSync(join(run, "transcript.jsonl"), "utf8"), /CLAUDE_CODE_OAUTH_TOKEN=<redacted-oauth-token>; again <redacted-oauth-token>/);
    assert.deepEqual(readFileSync(join(run, "blob.bin")),
      Buffer.concat([Buffer.from([0xff, 0x00, 0xfe]), Buffer.from(REDACTED_TOKEN), Buffer.from([0x80])]), "binary bytes around it are kept");
    assert.equal(readFileSync(join(run, "clean.txt"), "utf8"), "nothing here\n");
    if (linked) assert.equal(readFileSync(outsideFile, "utf8"), TOKEN, "a symlink target outside the run dir is not rewritten");
    assert.deepEqual(redactTokenInDir(run, TOKEN), { count: 0, failures: [] }, "idempotent");
    assert.deepEqual(redactTokenInDir(join(dir, "absent"), TOKEN), { count: 0, failures: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preflight probe verdict parsing over fixture outputs", () => {
  const transcript = [
    line({ type: "system", subtype: "init", apiKeySource: "none" }),
    line({ type: "result", subtype: "success", is_error: false, result: "first" }),
    "{not json",
    line({ type: "result", subtype: "success", is_error: false, result: "USER=0123456789abcdef\nPROJECT=fedcba9876543210" }),
  ].join("\n");
  assert.equal(resultText(transcript), "USER=0123456789abcdef\nPROJECT=fedcba9876543210");
  assert.equal(resultText(line({ type: "result", is_error: true })), null);
  assert.deepEqual(parseCanaryReply(resultText(transcript)), { user: "0123456789abcdef", project: "fedcba9876543210" });
  assert.deepEqual(parseCanaryReply("USER=NONE\nPROJECT=`fedcba9876543210`"), { user: null, project: "fedcba9876543210" });
  assert.deepEqual(parseCanaryReply("I cannot see any canary."), { user: null, project: null });
  assert.deepEqual(parseCanaryReply(null), { user: null, project: null });
  assert.equal(distinctiveLine("short\n  a line that is certainly thirty characters or more  \nx"), "a line that is certainly thirty characters or more");
  assert.equal(distinctiveLine("tiny\nlines only\n"), null);
});

test("armConfinement adds the user config root only when it is set", () => {
  const roots: ConfinementRoots = {
    sourceRepo: "/src/hunch", privateRepo: "/src/hunch-private", auditedRoot: "/bench/audited", dietRoot: null, controller: "/bench/c", out: "/out",
  };
  assert.deepEqual(armConfinement("no-hunch", roots).denyRoots, ["/src/hunch", "/src/hunch-private", "/bench/audited", "/bench/c", "/out"]);
  assert.deepEqual(armConfinement("no-hunch", { ...roots, userConfigRoot: null }).denyRoots, armConfinement("no-hunch", roots).denyRoots);
  for (const arm of ["no-hunch", "current-hunch", "diet-hunch"] as const) {
    assert.ok(armConfinement(arm, { ...roots, userConfigRoot: "/home/x/.claude" }).denyRoots.includes("/home/x/.claude"), arm);
  }
});

test("redactTokenInDir also redacts the JSON-escaped form, and lists unreadable entries without aborting", (t) => {
  const dir = tempDir();
  try {
    const userLine = 'Always quote "paths" like C:\\Users\\x when you answer the user';
    const escaped = JSON.stringify(userLine).slice(1, -1);
    assert.notEqual(escaped, userLine);
    writeFileSync(join(dir, "transcript.jsonl"), line({ type: "user", text: `Line: ${userLine}` }) + "\n");
    writeFileSync(join(dir, "raw.txt"), userLine);
    const locked = join(dir, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "secret.txt"), userLine);
    const canLock = process.platform !== "win32" && process.getuid?.() !== 0;
    if (canLock) chmodSync(join(locked, "secret.txt"), 0o000);
    const result = redactTokenInDir(dir, userLine, "<redacted-user-line>");
    assert.equal(readFileSync(join(dir, "raw.txt"), "utf8"), "<redacted-user-line>");
    const transcript = readFileSync(join(dir, "transcript.jsonl"), "utf8");
    assert.ok(!transcript.includes(escaped) && transcript.includes("<redacted-user-line>"), transcript);
    if (canLock) {
      assert.equal(result.count, 2);
      assert.deepEqual(result.failures, [`${join("locked", "secret.txt")}: EACCES`]);
    } else t.diagnostic("permission check skipped (root or Windows)");
  } finally {
    try { chmodSync(join(dir, "locked", "secret.txt"), 0o600); } catch { /* absent */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readOauthTokenFile refuses an unreadable token file without naming its path or content", (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) { t.skip("chmod 000 does not block reads here"); return; }
  const dir = gitFreeTempDir();
  if (dir === null) { t.skip("no temp dir outside a git work tree"); return; }
  const file = join(dir, "token.txt");
  try {
    writeFileSync(file, TOKEN);
    chmodSync(file, 0o000);
    let message = "";
    try { readOauthTokenFile(file, []); } catch (error) { message = (error as Error).message; }
    assert.match(message, /could not be read/);
    assert.ok(!message.includes(TOKEN) && !message.includes(dir) && !message.includes("token.txt"), message);
  } finally {
    chmodSync(file, 0o600);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removePreflightUserLineDirs removes every preflight user-instructions-absent dir and nothing else", () => {
  const out = tempDir();
  try {
    for (const n of ["1", "2"]) {
      mkdirSync(join(out, "preflight", n, "user-instructions-absent", "run"), { recursive: true });
      writeFileSync(join(out, "preflight", n, "user-instructions-absent", "run", "transcript.jsonl"), "a user line\n");
      mkdirSync(join(out, "preflight", n, "probe"), { recursive: true });
    }
    writeFileSync(join(out, "preflight", "1.json"), "{}\n");
    assert.deepEqual(removePreflightUserLineDirs(out), []);
    for (const n of ["1", "2"]) {
      assert.equal(existsSync(join(out, "preflight", n, "user-instructions-absent")), false, n);
      assert.equal(existsSync(join(out, "preflight", n, "probe")), true, n);
    }
    assert.equal(existsSync(join(out, "preflight", "1.json")), true);
    assert.deepEqual(removePreflightUserLineDirs(join(out, "absent")), []);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("isInsidePath resolves symlinks through the nearest existing ancestor, so the child need not exist", { skip: process.platform === "win32" }, () => {
  const base = tempDir();
  try {
    const real = join(base, "real");
    mkdirSync(join(real, "config"), { recursive: true });
    symlinkSync(real, join(base, "link"));
    // Root given via the symlink, child reported in realpath form and not yet created (e.g. auto memory MEMORY.md).
    const realBase = execFileSync("realpath", [real], { encoding: "utf8" }).trim();
    assert.equal(isInsidePath(join(realBase, "config", "projects", "p", "memory", "MEMORY.md"), join(base, "link", "config")), true);
    assert.equal(isInsidePath(join(base, "link", "config", "absent", "x"), join(realBase, "config")), true);
    assert.equal(isInsidePath(join(realBase, "other", "x"), join(base, "link", "config")), false);
    assert.equal(isInsidePath(join(base, "link", "config-sibling"), join(base, "link", "config")), false);
    // Acceptance direction: a link inside the root pointing out of it, or a dangling one, does not count.
    mkdirSync(join(base, "outside"));
    symlinkSync(join(base, "outside"), join(real, "config", "out-link"));
    symlinkSync(join(base, "nowhere"), join(real, "config", "dangling"));
    assert.equal(isInsidePath(join(real, "config", "out-link", "MEMORY.md"), join(real, "config"), "resolved"), false);
    assert.equal(isInsidePath(join(real, "config", "dangling", "x"), join(real, "config"), "resolved"), false);
    assert.equal(isInsidePath(join(realBase, "config", "p", "MEMORY.md"), join(base, "link", "config"), "resolved"), true);
    // Refusal direction keeps the as-given match.
    assert.equal(isInsidePath(join(real, "config", "out-link", "MEMORY.md"), join(real, "config")), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeRepoChangesPatch reports real changes only, ignoring the repo's own diff prefixes and a tracked-but-ignored file", () => {
  const runDir = tempDir();
  const repo = join(runDir, "repo");
  try {
    const git = (...args: string[]) => benchmarkGit(["-C", repo, ...args]);
    mkdirSync(repo);
    git("init", "-q");
    writeFileSync(join(repo, "tracked.txt"), "one\n");
    writeFileSync(join(repo, "secret.env"), "keep\n");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
    const base = benchmarkGitText(["-C", repo, "rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, ".gitignore"), "secret.env\n");
    git("config", "diff.noprefix", "true");
    writeFileSync(join(repo, "tracked.txt"), "two\n");
    writeFileSync(join(repo, "new.txt"), "new\n");
    writeRepoChangesPatch(runDir, base);
    const patch = readFileSync(join(runDir, "repo-changes.patch"), "utf8");
    assert.match(patch, /diff --git a\/tracked\.txt b\/tracked\.txt/);
    assert.match(patch, /diff --git a\/new\.txt b\/new\.txt/);
    assert.doesNotMatch(patch, /secret\.env\n.*deleted|deleted file[\s\S]*secret|a\/secret\.env/);
    assert.equal(existsSync(join(runDir, "repo-changes.index")), false);
    assert.equal(benchmarkGitText(["-C", repo, "diff", "--cached", "--name-only"]).trim(), "");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("redactText replaces the raw and the JSON-escaped form", () => {
  const needle = 'say "hi" C:\\x';
  const text = `raw ${needle} json ${JSON.stringify(needle)}`;
  assert.equal(redactText(text, needle, "<r>"), 'raw <r> json "<r>"');
});

/** Every file under `dir` (recursively), as [relative path, bytes]. */
function filesUnder(dir: string, prefix = ""): Array<[string, Buffer]> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry): Array<[string, Buffer]> => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path, join(prefix, entry.name));
    return entry.isFile() ? [[join(prefix, entry.name), readFileSync(path)]] : [];
  });
}

test("splitProbeLine splits at the whitespace nearest the middle, else the middle, keeping a 12+ char suffix", () => {
  assert.deepEqual(splitProbeLine("alpha beta gamma delta epsilon zeta eta"), { prefix: "alpha beta gamma", suffix: "delta epsilon zeta eta" });
  // No whitespace: the middle character.
  assert.deepEqual(splitProbeLine("abcdefghijklmnopqrstuvwxyz0123"), { prefix: "abcdefghijklmno", suffix: "pqrstuvwxyz0123" });
  // The nearest whitespace leaves a suffix under 12 chars: fall back to the middle.
  const line = "abcdefghijklmnopqrstuvwxyz0123456 short";
  assert.deepEqual(splitProbeLine(line), { prefix: line.slice(0, 19), suffix: line.slice(19) });
  for (const sample of ["alpha beta gamma delta epsilon zeta eta", line, 'Always answer the "benchmark" question with C:\\bench\\path style detail']) {
    const { prefix, suffix } = splitProbeLine(sample);
    assert.ok(sample.startsWith(prefix) && sample.endsWith(suffix) && suffix.length >= 12 && !prefix.includes(suffix), sample);
  }
});

type FakeMode = "real" | "user-canary-leak" | "completion-leak" | "user-canary-quoted" | "user-hook";

/** A fake claude that, like the real CLI under `--setting-sources project`, never reads the config-dir CLAUDE.md,
 *  reads the cwd CLAUDE.md, and answers the completion probe NONE; the leak modes break one of those. */
function writeFakeClaude(path: string, mode: FakeMode, userInstructionsFile: string): void {
  writeFileSync(path, `#!${process.execPath}
const { mkdirSync, readFileSync, appendFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const mode = ${JSON.stringify(mode)};
if (process.argv.includes("--version")) { console.log("9.9.9 (Fake Claude)"); process.exit(0); }
const prompt = readFileSync(0, "utf8");
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || "";
const configDir = process.env.CLAUDE_CONFIG_DIR;
const session = join(configDir, "projects", "p");
mkdirSync(session, { recursive: true });
appendFileSync(join(session, "session.jsonl"), JSON.stringify({ prompt, token }) + "\\n");
process.stderr.write("token " + token + "\\n");
const read = (file) => existsSync(file) ? readFileSync(file, "utf8") : "";
const canary = (text, name) => (new RegExp("Benchmark " + name + " canary: (\\\\w+)").exec(text) || [])[1] || "NONE";
let reply = "OK";
if (prompt.includes("Benchmark user canary")) {
  const leak = mode === "user-canary-leak" || mode === "user-canary-quoted";
  const user = leak ? canary(read(join(configDir, "CLAUDE.md")), "user") : "NONE";
  reply = "USER=" + (mode === "user-canary-quoted" ? '"' + user + '"' : user) + "\\nPROJECT=" + canary(read(join(process.cwd(), "CLAUDE" + ".md")), "project");
} else if (prompt.includes("<<<")) {
  reply = "NONE";
  if (mode === "completion-leak") {
    const prefix = prompt.slice(prompt.lastIndexOf("<<<") + 3, prompt.lastIndexOf(">>>"));
    const hit = read(${JSON.stringify(userInstructionsFile)}).split(/\\r?\\n/).map((l) => l.trim()).find((l) => l.startsWith(prefix));
    if (hit) reply = hit.slice(prefix.length).trim();
  }
}
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ type: "system", subtype: "init", model: "fake-model", apiKeySource: "none", mcp_servers: [], tools: ["Read"] });
if (mode === "user-hook") emit({ type: "system", subtype: "hook_response", hook_event: "UserPromptSubmit", stdout: "", exit_code: 0 });
emit({ type: "user", message: { role: "user", content: prompt }, env_token: token });
emit({ type: "result", subtype: "success", is_error: false, result: reply });
`);
  chmodSync(path, 0o755);
}

const FAKE_TOKEN = "sk-ant-oat01-FAKEtoken_abc-123";
const FAKE_USER_LINE = 'Always answer the "benchmark" question with C:\\bench\\path style detail';

/** Runs the neutral preflight against a fake claude in `mode`; asserts no token/line/prefix/suffix leak under workDir
 *  or in the result, then returns the result. */
async function runFakeNeutralPreflight(mode: FakeMode) {
  const dir = tempDir();
  try {
    const instructions = join(dir, "user-CLAUDE.md");
    writeFileSync(instructions, `# Mine\n${FAKE_USER_LINE}\nshort\n`);
    const fake = join(dir, "fake-claude");
    writeFakeClaude(fake, mode, instructions);
    const workDir = join(dir, "work");
    mkdirSync(workDir);
    const result = await preflight({ schema: "hunch.benchmark-runner/1", provider: "claude", executable: fake, model: "fake-model", effort: null },
      { workDir, probeTimeoutMs: 30_000, neutral: { token: FAKE_TOKEN, userInstructionsFile: instructions } });
    assert.deepEqual(result.checks.map((check) => check.id), [
      "executable", "version", "stripped-env", "probe", "probe-mcp-empty", "probe-no-mcp-tools",
      "probe-no-hook-events", "instructions-canaries", "user-instructions-absent", "token-redaction",
    ]);
    // The fake did write both: the redaction, not their absence, keeps them off disk.
    assert.ok(statSync(join(workDir, "user-instructions-absent", "config", "projects", "p", "session.jsonl")).size > 0);
    const { prefix, suffix } = splitProbeLine(FAKE_USER_LINE);
    const needles = [FAKE_TOKEN, ...[FAKE_USER_LINE, prefix, suffix].flatMap((text) => [text, JSON.stringify(text).slice(1, -1)])];
    const files = filesUnder(workDir);
    assert.ok(files.length > 0);
    for (const [path, bytes] of files) {
      for (const needle of needles) assert.equal(bytes.includes(Buffer.from(needle)), false, `${path} holds ${needle === FAKE_TOKEN ? "the token" : "the user line or a part"}`);
    }
    assert.ok(files.some(([, bytes]) => bytes.includes(Buffer.from(REDACTED_TOKEN))), "the token was redacted, not absent");
    assert.ok(files.some(([, bytes]) => bytes.includes(Buffer.from("<redacted-user-line>"))), "the user line was redacted, not absent");
    const serialized = JSON.stringify(result);
    for (const needle of needles) assert.equal(serialized.includes(needle), false);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("neutral preflight with a fake claude: every check passes and neither the token nor the user line stays on disk", async (t) => {
  if (process.platform === "win32") { t.skip("the fake claude is a shebang script"); return; }
  const result = await runFakeNeutralPreflight("real");
  assert.deepEqual(result.checks.filter((check) => !check.ok), [], JSON.stringify(result.checks, null, 2));
  assert.ok(result.ok);
  assert.match(result.checks.find((check) => check.id === "instructions-canaries")!.detail, /USER absent, PROJECT match/);
  assert.match(result.checks.find((check) => check.id === "user-instructions-absent")!.detail, /line hash [0-9a-f]{12};.*completion absent/);
});

test("neutral preflight fails instructions-canaries when the config-dir user canary is reported", async (t) => {
  if (process.platform === "win32") { t.skip("the fake claude is a shebang script"); return; }
  const result = await runFakeNeutralPreflight("user-canary-leak");
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.filter((check) => !check.ok).map((check) => check.id), ["instructions-canaries"]);
  assert.match(result.checks.find((check) => check.id === "instructions-canaries")!.detail, /USER present \(leak\), PROJECT match/);
});

test("neutral preflight fails user-instructions-absent when the reply completes the user line, and still scrubs it", async (t) => {
  if (process.platform === "win32") { t.skip("the fake claude is a shebang script"); return; }
  const result = await runFakeNeutralPreflight("completion-leak");
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.filter((check) => !check.ok).map((check) => check.id), ["user-instructions-absent"]);
  assert.match(result.checks.find((check) => check.id === "user-instructions-absent")!.detail, /completion reproduced \(leak\)/);
});

test("neutral preflight fails instructions-canaries when the user canary is reported in a non-canonical form", async (t) => {
  if (process.platform === "win32") { t.skip("the fake claude is a shebang script"); return; }
  const result = await runFakeNeutralPreflight("user-canary-quoted");
  assert.deepEqual(result.checks.filter((check) => !check.ok).map((check) => check.id), ["instructions-canaries"]);
  assert.match(result.checks.find((check) => check.id === "instructions-canaries")!.detail, /USER present \(leak\)/);
});

test("neutral preflight fails probe-no-hook-events when a user-level hook runs in the empty probe dir", async (t) => {
  if (process.platform === "win32") { t.skip("the fake claude is a shebang script"); return; }
  const result = await runFakeNeutralPreflight("user-hook");
  assert.deepEqual(result.checks.filter((check) => !check.ok).map((check) => check.id), ["probe-no-hook-events"]);
  assert.match(result.checks.find((check) => check.id === "probe-no-hook-events")!.detail, /^1 hook event\(s\)$/);
});
