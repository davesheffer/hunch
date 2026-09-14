import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { inspectIntegrations, repairIntegrationPins, integrationHealthFails, integrationSessionWarning, machineLocalIntegrationFiles, HARNESSES, CAPABILITIES } from "../src/integrations/health.js";
import { probeIntegration } from "../src/integrations/probe.js";
import { installClaudeHooks, writeMcpJson } from "../src/integrations/scaffold.js";
import { writeCodexConfig, writeCodexHooks, scaffoldProviders } from "../src/integrations/providers.js";
import { tempStore } from "./helpers.js";

const version = "1.23.1";
const launcher = (v = version) => ({ command: "npx", args: ["-y", `--package=hunch-exact@npm:@davesheffer/hunch@${v}`, "hunch"] });
const command = (v = version) => `npx -y --package=hunch-exact@npm:@davesheffer/hunch@${v} hunch hook`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hunch-integration-health-"));
  const write = (file: string, value: unknown) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof value === "string" ? value : JSON.stringify(value, null, 2));
  };
  write("package.json", { dependencies: { "@davesheffer/hunch": version } });
  const claude = (v = version) => { writeMcpJson(root, launcher(v)); installClaudeHooks(root, command(v)); };
  return { root, write, claude, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("original regression: dependency upgrades cannot leave stale MCP or hook pins healthy", () => {
  const f = fixture();
  try {
    f.claude("1.22.0");
    writeCodexConfig(f.root, launcher("1.22.0"));
    writeCodexHooks(f.root, launcher("1.22.0"));
    const report = inspectIntegrations(f.root);
    assert.equal(report.expectedVersion, version);
    assert.equal(integrationHealthFails(report), true);
    for (const file of [".mcp.json", ".claude/settings.json", ".codex/config.toml", ".codex/hooks.json"]) {
      assert.ok(report.issues.some(i => i.file === file && i.code === "version-drift"), file);
    }
    assert.equal(repairIntegrationPins(f.root).length, 4);
    assert.deepEqual(repairIntegrationPins(f.root), []);
    assert.equal(integrationHealthFails(inspectIntegrations(f.root)), false);
  } finally { f.cleanup(); }
});

test("configuration never certifies runtime hook delivery, enforcement, or model compliance", () => {
  const f = fixture();
  try {
    f.claude();
    f.write(".hunch/config.json", { firmness: "strict" });
    const report = inspectIntegrations(f.root, "claude");
    assert.equal(integrationHealthFails(report), false);
    for (const capability of CAPABILITIES) {
      assert.equal(report.harnesses[0]!.capabilities[capability].status, "untested");
      assert.equal(integrationHealthFails(report, [capability]), true);
    }
    f.write(".hunch/config.json", { firmness: "advisory" });
    assert.equal(inspectIntegrations(f.root, "claude").harnesses[0]!.capabilities["edit-blocking"].status, "advisory-only");
  } finally { f.cleanup(); }
});

test("upgrade rejects and repairs misrouted Codex hooks without changing user settings", () => {
  const f = fixture();
  try {
    writeCodexConfig(f.root, launcher());
    writeCodexHooks(f.root, { ...launcher(), args: [...launcher().args, "mcp"] });
    const file = join(f.root, ".codex/hooks.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.hooks.PreToolUse[0].hooks[0].timeout = 45;
    config.hooks.Stop[0].hooks[0].enabled = false;
    const foreign = { hooks: [{ type: "command", command: 'echo "@davesheffer/hunch@0.1.0 hunch mcp hook --provider codex"' }] };
    config.hooks.SessionStart.push(foreign);
    const before = `// preserve this comment\n${JSON.stringify(config, null, 2)}\n`;
    f.write(".codex/hooks.json", before);

    const report = inspectIntegrations(f.root, "codex");
    assert.ok(report.issues.some(i => i.code === "hook-command" && i.detail.includes("repair-pins")));
    assert.equal(integrationHealthFails(report), true);
    assert.notEqual(report.harnesses[0]!.capabilities.context.status, "verified");
    assert.deepEqual(repairIntegrationPins(f.root), [".codex/hooks.json"]);
    const after = readFileSync(file, "utf8");
    assert.equal(after, before.replaceAll(
      `${command().replace("hunch hook", "hunch mcp hook")} --provider codex`, `${command()} --provider codex`,
    ));
    assert.deepEqual(repairIntegrationPins(f.root), [], "a second repair changes nothing");
    assert.deepEqual(inspectIntegrations(f.root, "codex").issues, []);
  } finally { f.cleanup(); }
});

test("upgrade migrates legacy quoted launchers and disabled hooks without enabling them", () => {
  const f = fixture();
  try {
    const old = { command: "npx", args: ["-y", "--package=@davesheffer/hunch@1.22.0", "hunch"] };
    writeCodexConfig(f.root, old);
    writeCodexHooks(f.root, old);
    const file = join(f.root, ".codex/hooks.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.hooks.Stop[0].hooks[0].enabled = false;
    config.hooks.PreCompact[0].enabled = false;
    config.hooks.SessionStart[0].hooks[0].command = [...old.args, "mcp", "hook", "--provider", "codex"]
      .map(s => JSON.stringify(s)).join(" ");
    config.hooks.SessionStart[0].hooks[0].command = '"npx" ' + config.hooks.SessionStart[0].hooks[0].command;
    f.write(".codex/hooks.json", config);
    assert.deepEqual(repairIntegrationPins(f.root), [".codex/config.toml", ".codex/hooks.json"]);
    const after = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(after.hooks.Stop[0].hooks[0].enabled, false);
    assert.equal(after.hooks.PreCompact[0].enabled, false);
    for (const groups of Object.values(after.hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>) {
      for (const group of groups) for (const hook of group.hooks) {
        assert.match(hook.command, /^npx -y /);
        assert.ok(hook.command.includes(`--package=hunch-exact@npm:@davesheffer/hunch@${version}`));
        assert.ok(!hook.command.includes('"mcp"'));
      }
    }
    assert.ok(readFileSync(join(f.root, ".codex/config.toml"), "utf8").includes(`--package=hunch-exact@npm:@davesheffer/hunch@${version}`));
    assert.deepEqual(inspectIntegrations(f.root, "codex").issues, []);
    assert.deepEqual(repairIntegrationPins(f.root), []);
  } finally { f.cleanup(); }
});

test("intentionally disabled hooks do not block updates or certify a required capability", () => {
  const f = fixture();
  try {
    for (const [event, capability] of [["PreCompact", "compaction"], ["PreToolUse", "edit-blocking"]] as const) {
      for (const nested of [false, true]) {
        writeCodexConfig(f.root, launcher("1.22.0"));
        writeCodexHooks(f.root, launcher("1.22.0"));
        const file = join(f.root, ".codex/hooks.json");
        const config = JSON.parse(readFileSync(file, "utf8"));
        const group = config.hooks[event][0];
        (nested ? group.hooks[0] : group).enabled = false;
        f.write(".codex/hooks.json", config);
        repairIntegrationPins(f.root);
        const report = inspectIntegrations(f.root, "codex");
        assert.equal(integrationHealthFails(report), false);
        assert.equal(report.harnesses[0]!.capabilities[capability].status, "unsupported");
        assert.equal(integrationHealthFails(report, [capability]), true);
        const after = JSON.parse(readFileSync(file, "utf8"));
        assert.equal((nested ? after.hooks[event][0].hooks[0] : after.hooks[event][0]).enabled, false);
        assert.deepEqual(repairIntegrationPins(f.root), []);
      }
    }
  } finally { f.cleanup(); }
});

test("repair never interprets a quoted argument or shell wrapper as a Hunch launcher", () => {
  const f = fixture();
  try {
    writeCodexConfig(f.root, launcher());
    const invalid = [
      command().replace("hunch hook", 'hunch "hook --provider codex"'),
      `echo '${command()} --provider codex'`,
      `${command()} --provider codex && echo done`,
    ];
    for (const cmd of invalid) {
      f.write(".codex/hooks.json", { hooks: { SessionStart: [{ hooks: [{ type: "command", command: cmd }] }] } });
      const before = readFileSync(join(f.root, ".codex/hooks.json"), "utf8");
      assert.ok(inspectIntegrations(f.root, "codex").issues.some(i => i.code === "missing-hook"));
      assert.deepEqual(repairIntegrationPins(f.root), []);
      assert.equal(readFileSync(join(f.root, ".codex/hooks.json"), "utf8"), before);
    }
  } finally { f.cleanup(); }
});

test("hooks become verified only from host-delivered events on the expected version", async () => {
  const { recordHookObservation } = await import("../src/core/hookObservations.js");
  const { HUNCH_VERSION } = await import("../src/core/version.js");
  const f = fixture();
  try {
    f.claude();
    f.write(".hunch/config.json", { firmness: "strict" });
    recordHookObservation(f.root, "claude", "SessionStart");
    recordHookObservation(f.root, "claude", "PreToolUse");
    recordHookObservation(f.root, "cursor", "PreCompact");
    // The observation carries the running Hunch version; the fixture expects 1.23.1.
    let capabilities = inspectIntegrations(f.root, "claude").harnesses[0]!.capabilities;
    assert.equal(capabilities.context.status, "untested");
    assert.match(capabilities.context.detail, /not the expected 1\.23\.1/);
    f.write("package.json", { dependencies: { "@davesheffer/hunch": HUNCH_VERSION } });
    f.claude(HUNCH_VERSION);
    const report = inspectIntegrations(f.root, "claude");
    capabilities = report.harnesses[0]!.capabilities;
    assert.equal(capabilities.context.status, "verified");
    assert.equal(capabilities["edit-blocking"].status, "verified");
    assert.match(capabilities.context.detail, /SessionStart observed from the claude host/);
    assert.equal(capabilities.compaction.status, "untested", "another harness's event never verifies this one");
    assert.equal(capabilities["failure-capture"].status, "untested");
    assert.equal(integrationHealthFails(report, ["mcp"]), true, "a fresh-server probe is still required for mcp");
    assert.equal(integrationHealthFails(report, ["context", "edit-blocking"]), false);
    f.write(".hunch/config.json", { firmness: "advisory" });
    assert.equal(inspectIntegrations(f.root, "claude").harnesses[0]!.capabilities["edit-blocking"].status, "advisory-only", "an observed event cannot certify blocking when firmness does not block");
  } finally { f.cleanup(); }
});

test("failure capture requires an explicit failed-tool event, not successful PostToolUse delivery", async () => {
  const { recordHookObservation } = await import("../src/core/hookObservations.js");
  const { HUNCH_VERSION } = await import("../src/core/version.js");
  const f = fixture();
  try {
    f.write("package.json", { dependencies: { "@davesheffer/hunch": HUNCH_VERSION } });
    f.claude(HUNCH_VERSION);
    f.write(".hunch/config.json", { firmness: "strict" });

    recordHookObservation(f.root, "claude", "PostToolUse");
    let capability = inspectIntegrations(f.root, "claude").harnesses[0]!.capabilities["failure-capture"];
    assert.equal(capability.status, "untested");
    assert.match(capability.detail, /PostToolUse was observed.*failure capture remains untested/);

    recordHookObservation(f.root, "claude", "PostToolUseFailure");
    capability = inspectIntegrations(f.root, "claude").harnesses[0]!.capabilities["failure-capture"];
    assert.equal(capability.status, "verified");
    assert.match(capability.detail, /PostToolUseFailure observed from the claude host/);
  } finally { f.cleanup(); }
});

test("failure capture accepts an explicit nonzero PostToolUse result while historical success-only evidence stays untested", async () => {
  const { recordHookObservation } = await import("../src/core/hookObservations.js");
  const { HUNCH_VERSION } = await import("../src/core/version.js");
  const f = fixture();
  try {
    f.write("package.json", { dependencies: { "@davesheffer/hunch": HUNCH_VERSION } });
    writeCodexConfig(f.root, launcher(HUNCH_VERSION));
    writeCodexHooks(f.root, launcher(HUNCH_VERSION));
    f.write(".hunch/config.json", { firmness: "strict" });

    // Rows written before outcome tracking have no result and must remain
    // historical delivery evidence, never failure proof.
    recordHookObservation(f.root, "codex", "PostToolUse");
    let capability = inspectIntegrations(f.root, "codex").harnesses[0]!.capabilities["failure-capture"];
    assert.equal(capability.status, "untested");

    recordHookObservation(f.root, "codex", "PostToolUse", "success");
    capability = inspectIntegrations(f.root, "codex").harnesses[0]!.capabilities["failure-capture"];
    assert.equal(capability.status, "untested");

    recordHookObservation(f.root, "codex", "PostToolUse", "failure");
    capability = inspectIntegrations(f.root, "codex").harnesses[0]!.capabilities["failure-capture"];
    assert.equal(capability.status, "verified");
    assert.match(capability.detail, /PostToolUse observed from the codex host/);

    // A later successful command must not erase the most recent failure proof.
    recordHookObservation(f.root, "codex", "PostToolUse", "success");
    capability = inspectIntegrations(f.root, "codex").harnesses[0]!.capabilities["failure-capture"];
    assert.equal(capability.status, "verified");
  } finally { f.cleanup(); }
});

test("fresh expected-version failure evidence wins over a stale failure row", async () => {
  const { recordHookObservation, readHookObservations } = await import("../src/core/hookObservations.js");
  const { withServedDatabase } = await import("../src/core/served.js");
  const { HUNCH_VERSION } = await import("../src/core/version.js");
  const f = fixture();
  try {
    f.write("package.json", { dependencies: { "@davesheffer/hunch": HUNCH_VERSION } });
    writeCodexConfig(f.root, launcher(HUNCH_VERSION));
    writeCodexHooks(f.root, launcher(HUNCH_VERSION));
    f.write(".hunch/config.json", { firmness: "strict" });
    recordHookObservation(f.root, "codex", "PostToolUse", "failure");
    assert.equal(readHookObservations(f.root).find(row => row.event === "PostToolUse")?.outcome, "failure");
    withServedDatabase(f.root, db => db.prepare(
      "INSERT INTO hook_observations (provider, event, at, version, outcome) VALUES (?, ?, ?, ?, ?)",
    ).run("codex", "PostToolUseFailure", new Date().toISOString(), "1.0.0", "failure"));

    const capability = inspectIntegrations(f.root, "codex").harnesses[0]!.capabilities["failure-capture"];
    assert.equal(capability.status, "verified");
    assert.match(capability.detail, /PostToolUse observed from the codex host/);
  } finally { f.cleanup(); }
});

test("legacy four-column hook observation ledgers migrate without treating old rows as failure evidence", async (t) => {
  const { readHookObservations, recordHookObservation } = await import("../src/core/hookObservations.js");
  const root = mkdtempSync(join(tmpdir(), "hunch-hook-observations-legacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = join(root, ".hunch-cache");
  mkdirSync(cache, { recursive: true });
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(join(cache, "served.db"));
  db.exec(`CREATE TABLE hook_observations (
    provider TEXT NOT NULL, event TEXT NOT NULL, at TEXT NOT NULL, version TEXT NOT NULL,
    PRIMARY KEY (provider, event)
  )`);
  db.prepare("INSERT INTO hook_observations VALUES (?, ?, ?, ?)").run("codex", "PostToolUse", new Date().toISOString(), "1.32.5");
  db.close();

  assert.equal(readHookObservations(root)[0]?.outcome, null, "legacy rows are unknown after additive migration");
  recordHookObservation(root, "codex", "PostToolUse", "failure");
  assert.equal(readHookObservations(root)[0]?.outcome, "failure");
});

test("Codex MCP configuration alone cannot imply lifecycle support; its hooks file makes the capabilities configurable but still unverified", () => {
  const f = fixture();
  try {
    writeCodexConfig(f.root, launcher());
    const mcpOnly = inspectIntegrations(f.root, "codex");
    assert.deepEqual(mcpOnly.issues, [], "an adapter that was never installed is a coverage gap, not drift — hunch update must keep working for MCP-only Codex users");
    assert.match(mcpOnly.harnesses[0]!.capabilities.context.detail, /run hunch init/);
    assert.equal(integrationHealthFails(mcpOnly, ["context"]), true, "but nothing unverified satisfies --require");
    writeCodexHooks(f.root, launcher());
    const report = inspectIntegrations(f.root, "codex");
    assert.deepEqual(report.issues, []);
    const capabilities = report.harnesses[0]!.capabilities;
    for (const c of ["context", "failure-capture", "compaction"] as const) assert.equal(capabilities[c].status, "untested", c);
    assert.equal(capabilities["edit-blocking"].status, "advisory-only", "default firmness never blocks, on Codex as on Claude Code");
    assert.equal(integrationHealthFails(report, ["context"]), true, "configured is not verified: only a codex-delivered event can prove delivery");
  } finally { f.cleanup(); }
});

test("all generated adapters are inspected and repaired against the consuming dependency", () => {
  const { root, store, cleanup } = tempStore();
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "@davesheffer/hunch": version } }));
    writeMcpJson(root, launcher("1.22.0"));
    installClaudeHooks(root, command("1.22.0"));
    scaffoldProviders(root, launcher("1.22.0"), store, { home: root });
    assert.equal(inspectIntegrations(root).harnesses.length, Object.keys(HARNESSES).length);
    assert.equal(repairIntegrationPins(root).length, 12);
    assert.deepEqual(inspectIntegrations(root).issues, []);
  } finally { cleanup(); }
});

test("repair preserves comments, foreign servers, foreign hooks and unrelated settings", () => {
  const f = fixture();
  try {
    f.claude("1.22.0");
    const file = join(f.root, ".mcp.json");
    const before = readFileSync(file, "utf8").replace('"mcpServers": {', '// retain this comment\n  "mcpServers": {\n    "other": {"command":"echo", "args":["@davesheffer/hunch@0.1.0"]},');
    writeFileSync(file, before);
    const hooksFile = join(f.root, ".claude/settings.json");
    const hooks = JSON.parse(readFileSync(hooksFile, "utf8"));
    hooks.permissions = { allow: ["Read"] };
    hooks.hooks.SessionStart.push({ hooks: [{ type: "command", command: 'echo "@davesheffer/hunch@0.1.0"' }] });
    writeFileSync(hooksFile, JSON.stringify(hooks));
    repairIntegrationPins(f.root);
    assert.equal(readFileSync(file, "utf8"), before.replaceAll("hunch@1.22.0", `hunch@${version}`));
    const after = JSON.parse(readFileSync(hooksFile, "utf8"));
    assert.deepEqual(after.permissions, hooks.permissions);
    assert.deepEqual(after.hooks.SessionStart[1], hooks.hooks.SessionStart[1]);
  } finally { f.cleanup(); }
});

test("a harness whose hooks are committed but whose MCP config simply doesn't exist here yet is untested, not a hard issue — only a malformed or broken config is a real issue", () => {
  const f = fixture();
  try {
    // Only the hooks half — mirrors a harness whose hooks file is intentionally
    // committed while its MCP config is gitignored/per-developer and hasn't
    // been generated on this checkout yet (e.g. a fresh clone, before `hunch
    // init`/local host setup). This must read as "not configured here", not
    // as a repository-level misconfiguration.
    installClaudeHooks(f.root, command());
    const report = inspectIntegrations(f.root);
    assert.equal(report.harnesses[0]!.capabilities.mcp.status, "untested");
    assert.equal(report.issues.some(i => i.file === ".mcp.json"), false, "a simply-absent mcp config must not be scored as an issue");
    assert.equal(integrationHealthFails(report), false);

    const selected = inspectIntegrations(f.root, "claude");
    assert.ok(selected.issues.some(i => i.file === ".mcp.json" && i.code === "mcp-config"), "an explicit harness check must report its missing MCP config");
    assert.equal(integrationHealthFails(selected), true);
    assert.match(integrationSessionWarning(f.root, "claude"), /\.mcp\.json/);

    // Contrast: once the file EXISTS but is broken, that's a genuine issue —
    // this must keep failing exactly as before.
    f.write(".mcp.json", "{broken");
    const broken = inspectIntegrations(f.root);
    assert.ok(broken.issues.some(i => i.file === ".mcp.json" && i.code === "mcp-config"));
    assert.equal(integrationHealthFails(broken), true);

    if (process.platform !== "win32") {
      rmSync(join(f.root, ".mcp.json"));
      symlinkSync(join(f.root, "missing-mcp-target.json"), join(f.root, ".mcp.json"));
      const dangling = inspectIntegrations(f.root);
      assert.ok(dangling.issues.some(i => i.file === ".mcp.json" && i.code === "mcp-config"), "a dangling config symlink is broken, not absent");
    }
  } finally { f.cleanup(); }
});

test("an explicitly selected but entirely unconfigured harness remains a hard issue", () => {
  const f = fixture();
  try {
    const report = inspectIntegrations(f.root, "claude");
    assert.ok(report.issues.some(i => i.file === ".mcp.json" && i.code === "mcp-config"));
    assert.equal(integrationHealthFails(report), true);
    assert.doesNotMatch(report.harnesses[0]!.capabilities.mcp.detail, /hooks file exists/);
  } finally { f.cleanup(); }
});

test("malformed config aborts repair before any good file is changed", () => {
  const f = fixture();
  try {
    f.claude("1.22.0");
    const before = readFileSync(join(f.root, ".mcp.json"), "utf8");
    f.write(".cursor/mcp.json", "{broken");
    assert.throws(() => repairIntegrationPins(f.root));
    assert.equal(readFileSync(join(f.root, ".mcp.json"), "utf8"), before);
    assert.ok(inspectIntegrations(f.root).issues.some(i => i.file === ".cursor/mcp.json" && i.code === "mcp-config"));
  } finally { f.cleanup(); }
});

test("foreign and malformed TOML are never rewritten", () => {
  const f = fixture();
  try {
    f.claude("1.22.0");
    for (const raw of ["[mcp_servers.hunch]\ncommand = 'custom'", "# >>> hunch mcp (managed) >>>\n[mcp_servers.hunch]\ncommand = 'npx'\nargs = [unquoted]\n# <<< hunch mcp <<<"]) {
      f.write(".codex/config.toml", raw);
      assert.throws(() => repairIntegrationPins(f.root));
      assert.equal(readFileSync(join(f.root, ".codex/config.toml"), "utf8"), raw);
      assert.ok(readFileSync(join(f.root, ".mcp.json"), "utf8").includes("hunch@1.22.0"));
    }
    // Restore a valid user document before exercising the writer itself; the
    // writer must refuse malformed managed content rather than erase it.
    f.write(".codex/config.toml", "model = 'gpt-5'\n");
    writeCodexConfig(f.root, launcher("1.22.0"));
    const valid = readFileSync(join(f.root, ".codex/config.toml"), "utf8");
    f.write(".codex/config.toml", valid + "\ninvalid = [unterminated\n");
    assert.throws(() => repairIntegrationPins(f.root));
    assert.ok(readFileSync(join(f.root, ".mcp.json"), "utf8").includes("hunch@1.22.0"));
  } finally { f.cleanup(); }
});

test("missing, disabled, and foreign-only hooks cannot satisfy capability requirements", () => {
  const f = fixture();
  try {
    f.claude();
    f.write(".claude/settings.json", { hooks: { PreToolUse: [{ hooks: [{ command: "echo hello" }] }] } });
    assert.ok(inspectIntegrations(f.root, "claude").issues.some(i => i.code === "missing-hook"));
    f.claude();
    const config = JSON.parse(readFileSync(join(f.root, ".claude/settings.json"), "utf8"));
    config.disableAllHooks = true;
    f.write(".claude/settings.json", config);
    const report = inspectIntegrations(f.root, "claude");
    assert.equal(report.harnesses[0]!.capabilities.context.status, "unsupported");
    assert.equal(integrationHealthFails(report, ["context"]), true);
  } finally { f.cleanup(); }
});

test("unknown dependency ranges, conflicting versions, and absent integrations fail explicitly", () => {
  const f = fixture();
  try {
    assert.equal(integrationHealthFails(inspectIntegrations(f.root)), true);
    f.write("package.json", { dependencies: { "@davesheffer/hunch": "^1.23.1" } });
    assert.ok(inspectIntegrations(f.root).issues.some(i => i.code === "dependency-version"));
    assert.throws(() => repairIntegrationPins(f.root));
    f.write("package.json", { dependencies: { "@davesheffer/hunch": version }, devDependencies: { "@davesheffer/hunch": "1.22.0" } });
    assert.ok(inspectIntegrations(f.root).issues.some(i => i.code === "dependency-version"));
  } finally { f.cleanup(); }
});

test("repair refuses symlinks and ambiguous foreign copies of the same pin", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    f.claude("1.22.0");
    const raw = readFileSync(join(f.root, ".mcp.json"), "utf8");
    f.write("copy.json", raw);
    rmSync(join(f.root, ".mcp.json"));
    symlinkSync(join(f.root, "copy.json"), join(f.root, ".mcp.json"));
    assert.throws(() => repairIntegrationPins(f.root), /symlink/);
    rmSync(join(f.root, ".mcp.json"));
    const config = JSON.parse(raw);
    config.mcpServers.foreign = config.mcpServers.hunch;
    f.write(".mcp.json", config);
    assert.throws(() => repairIntegrationPins(f.root), /ambiguous/);
    assert.equal(readFileSync(join(f.root, "copy.json"), "utf8"), raw);
  } finally { f.cleanup(); }
});

test("incorrect dialects and floating npm launchers produce session warnings", () => {
  const f = fixture();
  try {
    f.claude();
    assert.equal(integrationSessionWarning(f.root, "claude"), "");
    const file = join(f.root, ".claude/settings.json");
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("hunch hook", "hunch hook --provider cursor"));
    assert.ok(inspectIntegrations(f.root, "claude").issues.some(i => i.code === "missing-hook"));
    assert.match(integrationSessionWarning(f.root, "claude"), /needs attention/);
    f.write(".mcp.json", { mcpServers: { hunch: { command: "npx", args: ["--package=@davesheffer/hunch", "hunch", "mcp"] } } });
    assert.ok(inspectIntegrations(f.root, "claude").issues.some(i => i.code === "unpinned-package"));
  } finally { f.cleanup(); }
});

test("CLI reports JSON and fails requirements; pin repair clears the original mismatch", () => {
  const f = fixture();
  const cli = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "integrations", ...args], { cwd: f.root, encoding: "utf8", timeout: 15_000 });
  try {
    mkdirSync(join(f.root, ".git"));
    f.claude("1.22.0");
    let result = run("check", "--json");
    assert.equal(result.status, 1, result.stderr);
    assert.ok(JSON.parse(result.stdout).issues.some((i: { code: string }) => i.code === "version-drift"));
    result = run("repair-pins");
    assert.equal(result.status, 0, result.stderr);
    result = run("check", "--harness", "claude", "--require", "context", "--json");
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).harnesses[0].capabilities.context.status, "untested");
    assert.equal(run("check", "--require", "typo").status, 1);
    assert.equal(run("check", "--probe").status, 1);
    assert.equal(run("check", "--harness", "unknown").status, 1);
  } finally { f.cleanup(); }
});

test("CLI upgrade repairs installed Codex hooks into a runnable handler", () => {
  const f = fixture();
  const cli = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: f.root, encoding: "utf8", timeout: 15_000 });
  try {
    mkdirSync(join(f.root, ".git"));
    writeCodexConfig(f.root, launcher("1.22.0"));
    writeCodexHooks(f.root, { ...launcher("1.22.0"), args: [...launcher("1.22.0").args, "mcp"] });
    const before = run("integrations", "check", "--harness", "codex", "--json");
    assert.equal(before.status, 1, before.stderr);
    assert.ok(JSON.parse(before.stdout).issues.some((i: { code: string }) => i.code === "hook-command"));
    const repaired = run("integrations", "repair-pins");
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.match(repaired.stdout, /\/hooks/);
    const hooksFile = join(f.root, ".codex/hooks.json");
    const hooks = JSON.parse(readFileSync(hooksFile, "utf8"));
    const args = hooks.hooks.SessionStart[0].hooks[0].command.split(" ").slice(4);
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: f.root, encoding: "utf8", timeout: 15_000,
      input: JSON.stringify({ hook_event_name: "SessionStart", cwd: f.root, session_id: "upgrade-smoke" }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, "SessionStart");
    const stable = readFileSync(hooksFile, "utf8");
    assert.equal(run("integrations", "repair-pins").status, 0);
    assert.equal(readFileSync(hooksFile, "utf8"), stable);
  } finally { f.cleanup(); }
});

test("probe never executes custom commands or ignores custom environments", async () => {
  const f = fixture();
  try {
    f.write(".mcp.json", { mcpServers: { hunch: { command: "does-not-exist", args: [] } } });
    let report = inspectIntegrations(f.root, "claude");
    await probeIntegration(f.root, "claude", report);
    assert.equal(report.harnesses[0]!.capabilities.mcp.status, "untested");
    assert.ok(report.issues.some(i => i.code === "mcp-probe" && i.detail.includes("generated")));
    f.claude();
    const config = JSON.parse(readFileSync(join(f.root, ".mcp.json"), "utf8"));
    config.mcpServers.hunch.env = { EXAMPLE: "secret" };
    f.write(".mcp.json", config);
    report = inspectIntegrations(f.root, "claude");
    await probeIntegration(f.root, "claude", report);
    assert.ok(report.issues.some(i => i.code === "mcp-probe" && i.detail.includes("environment")));
    assert.ok(!JSON.stringify(report).includes("secret"));
  } finally { f.cleanup(); }
});

test("repair can skip machine-local files so a release cut never pins a version npm cannot serve", () => {
  const f = fixture();
  try {
    f.claude("1.22.0");
    writeCodexConfig(f.root, launcher("1.22.0"));
    const repaired = repairIntegrationPins(f.root, { skip: (file) => file === ".mcp.json" || file === ".claude/settings.json" });
    assert.deepEqual(repaired, [".codex/config.toml"]);
    assert.ok(readFileSync(join(f.root, ".mcp.json"), "utf8").includes("hunch@1.22.0"), "skipped file untouched");
    assert.ok(readFileSync(join(f.root, ".codex/config.toml"), "utf8").includes(`hunch@${version}`));
    const report = inspectIntegrations(f.root);
    assert.deepEqual(report.pins.filter(p => p.file === ".mcp.json"), [{ file: ".mcp.json", version: "1.22.0" }]);
    assert.ok(report.pins.some(p => p.file === ".codex/config.toml" && p.version === version));
    assert.equal(new Set(report.pins.map(p => `${p.file}@${p.version}`)).size, report.pins.length, "one entry per file+version");
  } finally { f.cleanup(); }
});

test("the managed Codex block keeps its startup timeout through pin repair", () => {
  const f = fixture();
  try {
    f.claude();
    writeCodexConfig(f.root, launcher("1.22.0"));
    writeCodexHooks(f.root, launcher());
    const before = readFileSync(join(f.root, ".codex/config.toml"), "utf8");
    assert.match(before, /^startup_timeout_sec = 60$/m);
    assert.deepEqual(repairIntegrationPins(f.root), [".codex/config.toml"]);
    const after = readFileSync(join(f.root, ".codex/config.toml"), "utf8");
    assert.match(after, /^startup_timeout_sec = 60$/m);
    assert.ok(after.includes(`hunch@${version}`));
    assert.deepEqual(inspectIntegrations(f.root, "codex").issues, []);
  } finally { f.cleanup(); }
});

test("machine-local integration files are the git-ignored ones", () => {
  const f = fixture();
  try {
    f.claude();
    writeCodexConfig(f.root, launcher());
    assert.deepEqual(machineLocalIntegrationFiles(f.root), [], "no git repo: nothing is known to be local");
    spawnSync("git", ["init", "-q"], { cwd: f.root });
    f.write(".gitignore", ".mcp.json\n.codex/config.toml\n");
    assert.deepEqual(machineLocalIntegrationFiles(f.root).sort(), [".codex/config.toml", ".mcp.json"]);
    const kept = new Set(machineLocalIntegrationFiles(f.root));
    f.claude("1.22.0");
    writeCodexConfig(f.root, launcher("1.22.0"));
    assert.deepEqual(repairIntegrationPins(f.root, { skip: (file) => kept.has(file) }), [".claude/settings.json"]);
  } finally { f.cleanup(); }
});
