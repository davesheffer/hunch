import type { Command } from "commander";
import { findRoot } from "../core/paths.js";
import { CAPABILITIES, HARNESSES, inspectIntegrations, integrationHealthFails, formatIntegrationHealth, repairIntegrationPins, type Capability, type Harness } from "../integrations/health.js";
import { probeIntegration } from "../integrations/probe.js";
import { describeGitignoreUpgrade, upgradeManagedGitignore } from "../integrations/gitignore.js";

export function registerIntegrationCommands(program: Command, refreshGrounding: () => string[]): void {
  const integrations = program.command("integrations").description("Check harness coverage and repair stale repository Hunch pins");
  integrations.command("check")
    .description("Fail on configuration drift; optionally require verified capabilities for CI")
    .option("--harness <name>", "claude | codex | cursor | vscode | windsurf | antigravity")
    .option("--require <capabilities>", "comma-separated capabilities that must be verified")
    .option("--probe", "start the selected harness's published Hunch MCP launcher and perform a memory read (may download its pinned package)")
    .option("--json", "machine-readable report")
    .action(async (opts: { harness?: string; require?: string; probe?: boolean; json?: boolean }) => {
      if (opts.harness && !Object.hasOwn(HARNESSES, opts.harness)) throw new Error(`unknown harness: ${opts.harness}`);
      if (opts.probe && !opts.harness) throw new Error("--probe requires --harness");
      const required = opts.require === undefined ? [] : opts.require.split(",").map(c => c.trim());
      if (required.some(c => !(CAPABILITIES as readonly string[]).includes(c))) throw new Error(`--require accepts ${CAPABILITIES.join(",")}`);
      const root = findRoot();
      const report = inspectIntegrations(root, opts.harness as Harness | undefined);
      if (opts.probe) await probeIntegration(root, opts.harness as Harness, report);
      console.log(opts.json ? JSON.stringify(report, null, 2) : formatIntegrationHealth(report));
      if (integrationHealthFails(report, required as Capability[])) process.exitCode = 1;
    });
  integrations.command("repair-pins")
    .description("Align pins, repair known Hunch launch commands and refresh instructions; preserves other settings and does not enable hooks")
    .action(() => {
      const root = findRoot();
      const files = repairIntegrationPins(root);
      console.log(files.length ? `Updated ${files.length} integration file(s): ${files.join(", ")}. Reconnect active MCP sessions.` : "Integration pins already aligned.");
      if (files.includes(".codex/hooks.json")) {
        console.log("Codex: open /hooks to review and trust the changed commands, then start a new session. Command changes require renewed trust; Hunch does not grant it automatically.");
      }
      // `hunch update` runs this command with the NEW release, so existing repos pick up
      // managed .gitignore entries added since they were set up (no re-init needed).
      try {
        for (const line of describeGitignoreUpgrade(upgradeManagedGitignore(root))) console.log(line);
      } catch (error) {
        console.log(`.gitignore not upgraded: ${(error as Error).message}`);
      }
      const grounding = refreshGrounding();
      if (grounding.length) console.log(`Updated Hunch instructions: ${grounding.join(", ")}. Reconnect the agent to load task reporting instructions.`);
      const report = inspectIntegrations(root);
      console.log(formatIntegrationHealth(report));
      if (integrationHealthFails(report)) process.exitCode = 1;
    });
}
