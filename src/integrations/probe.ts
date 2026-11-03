import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { sameFilesystemEntry } from "../extractors/git.js";
import { HARNESSES, readLauncher, type Harness, type IntegrationHealth } from "./health.js";

/** A launcher that runs THIS Hunch build directly (`node <build>/cli/index.js mcp`) —
 *  a local checkout or an unpacked test build. It is exactly the code already
 *  running the probe, so starting it executes nothing new; any other custom
 *  command stays inspect-only. The server identity/version check still applies.
 *  The command is a bare `node` (PATH lookup) or this exact Node binary — a
 *  directory-qualified `./tools/node` in a cloned repo is not, whatever its name —
 *  and the probe spawns process.execPath itself, never the configured name. */
export function isSelfLauncher(launcher: { command: string; args: string[] }, entry = fileURLToPath(new URL("../cli/index.js", import.meta.url))): boolean {
  const bareNode = /^node(?:\.exe)?$/i.test(launcher.command);
  const node = bareNode || (isAbsolute(launcher.command) && existsSync(launcher.command) && sameFilesystemEntry(launcher.command, process.execPath));
  if (!node || launcher.args.length !== 2 || launcher.args[1] !== "mcp") return false;
  const script = launcher.args[0]!;
  // Generated launchers name the build entry absolutely; a relative script would resolve
  // against whatever cwd the host spawns in.
  return isAbsolute(script) && existsSync(script) && existsSync(entry) && sameFilesystemEntry(script, entry);
}

/** Opt-in: starts a fresh configured MCP process, never claims the current
 * harness connection or hook delivery has been tested. No model is invoked. */
export async function probeIntegration(root: string, harness: Harness, report: IntegrationHealth, timeoutMs = 15_000): Promise<void> {
  const health = report.harnesses.find(h => h.harness === harness);
  if (!health) throw new Error(`missing ${harness} inspection`);
  const client = new Client({ name: "hunch-integration-probe", version: "1" });
  let transport: StdioClientTransport | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const launcher = readLauncher(root, harness);
    if (launcher.customEnvironment) throw new Error("custom MCP environment or working directory requires a host-side probe; no settings were ignored");
    // Only execute the exact published launcher Hunch generates. Custom
    // commands may need credentials or have unrelated effects; inspect only.
    const generated = /^npx(?:\.cmd)?$/.test(launcher.command) && JSON.stringify(launcher.args) === JSON.stringify([
      "-y", `--package=hunch-exact@npm:@davesheffer/hunch@${report.expectedVersion}`, "hunch", "mcp",
    ]);
    const self = !generated && isSelfLauncher(launcher);
    if (!generated && !self) throw new Error("probe requires the generated exact-version npx launcher, or a `node <build>/cli/index.js mcp` launcher probed by that same build; repair stale pins first; other custom launchers remain untested");
    // A self launcher runs this exact Node binary: no PATH/cwd lookup of `node` can
    // resolve to an executable planted in the repository.
    transport = new StdioClientTransport({ ...launcher, ...(self ? { command: process.execPath } : {}), cwd: root, stderr: "pipe" });
    transport.stderr?.on("data", () => {});
    await Promise.race([
      (async () => {
        await client.connect(transport!);
        const server = client.getServerVersion();
        if (server?.name !== "hunch" || server.version !== report.expectedVersion) throw new Error("MCP server identity/version does not match the repository dependency");
        const { tools } = await client.listTools();
        if (!tools.some(t => t.name === "hunch_context") || !tools.some(t => t.name === "hunch_structure")) throw new Error("required Hunch memory tools are missing");
        const result = await client.callTool({ name: "hunch_structure", arguments: {} });
        if (result.isError || !Array.isArray(result.content) || !result.content.some(c => c.type === "text" && c.text)) throw new Error("Hunch memory read failed");
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MCP probe timed out")), timeoutMs); }),
    ]);
    health.capabilities.mcp = { status: "verified", detail: `Fresh MCP process reports ${report.expectedVersion}; memory tool read succeeded. Existing host sessions were not probed` };
  } catch (e) {
    report.issues.push({ file: HARNESSES[harness].mcp, code: "mcp-probe", detail: (e as Error).message });
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => {});
    await transport?.close().catch(() => {});
  }
}
