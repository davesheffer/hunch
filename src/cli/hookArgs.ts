/** `{ provider }` only for exactly `hook`, `hook --provider X` or `hook --provider=X`
 *  (X non-empty); null sends the invocation through the full CLI. The shim in
 *  tooling/bundle-cli.mjs applies the same rule inline. Dependency-free: the hook
 *  daemon client (hookClient.ts) uses it without loading the hook handler. */
export function fastHookArgs(args: string[]): { provider: string } | null {
  if (args[0] !== "hook") return null;
  if (args.length === 1) return { provider: "claude" };
  if (args.length === 3 && args[1] === "--provider" && args[2]) return { provider: args[2] };
  if (args.length === 2 && args[1]!.startsWith("--provider=") && args[1]!.length > "--provider=".length) {
    return { provider: args[1]!.slice("--provider=".length) };
  }
  return null;
}
