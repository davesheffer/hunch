/**
 * The opt-out marker `hunch uninstall` leaves (#449), apart from uninstall.ts so the
 * hook installers can honor it without an import cycle (uninstall.ts imports hooks.ts).
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";

/** The opt-out marker, at the repository root. Commit it so every clone stays opted out. */
export const OPT_OUT_FILE = ".hunch-removed";

export function isOptedOut(root: string): boolean {
  try { return lstatSync(join(root, OPT_OUT_FILE)).isFile(); } catch { return false; }
}
