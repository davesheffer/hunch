/**
 * Node-version gate — MUST be the first import of the CLI entry, and must itself
 * import nothing: the store loads `node:sqlite` eagerly (db.ts), so on Node < 22.13
 * the import graph dies with a raw ERR_UNKNOWN_BUILTIN_MODULE before Commander can
 * print anything helpful. ESM evaluates this module (no deps) before the rest of
 * the graph, so the check runs first and the user gets an actionable message.
 */
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  // The agent edit-hook must never block an edit on failure (con_03a0b94b2e):
  // emit nothing and exit 0 — the edit proceeds ungrounded rather than blocked.
  if (process.argv[2] === "hook") process.exit(0);
  process.stderr.write(
    `hunch: Node ${process.versions.node} is too old — hunch needs Node >= 22.13 (its index uses the built-in node:sqlite).\n` +
    "Upgrade Node (e.g. `nvm install 24 && nvm use 24`) and re-run.\n",
  );
  process.exit(1);
}

export {};
