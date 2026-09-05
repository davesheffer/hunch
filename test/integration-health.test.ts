import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectIntegrations, repairIntegrationPins, integrationHealthFails, integrationSessionWarning, HARNESSES, CAPABILITIES } from "../src/integrations/health.js";
import { probeIntegration } from "../src/integrations/probe.js";
import { installClaudeHooks, writeMcpJson } from "../src/integrations/scaffold.js";
import { writeCodexConfig, scaffoldProviders } from "../src/integrations/providers.js";
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
    const report = inspectIntegrations(f.root);
    assert.equal(report.expectedVersion, version);
    assert.equal(integrationHealthFails(report), true);
    for (const file of [".mcp.json", ".claude/settings.json", ".codex/config.toml"]) {
      assert.ok(report.issues.some(i => i.file === file && i.code === "version-drift"), file);
    }
    assert.equal(repairIntegrationPins(f.root).length, 3);
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

test("Codex MCP configuration cannot imply lifecycle support", () => {
  const f = fixture();
  try {
    writeCodexConfig(f.root, launcher());
    const report = inspectIntegrations(f.root, "codex");
    const capabilities = report.harnesses[0]!.capabilities;
    assert.equal(capabilities.context.status, "advisory-only");
    for (const c of ["edit-blocking", "failure-capture", "compaction"] as const) assert.equal(capabilities[c].status, "unsupported");
    assert.equal(integrationHealthFails(report, ["context"]), true);
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
    assert.equal(repairIntegrationPins(root).length, 11);
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
