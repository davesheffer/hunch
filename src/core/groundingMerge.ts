@@CLEANROOM_HOLE_1@@
import { normalizeEol } from "./eol.js";
@@CLEANROOM_HOLE_2@@
// The entry point normalizes EOL before matching. `^...$` with /m anchors
// each marker at its own line start rather than
@@CLEANROOM_HOLE_3@@
const CONFLICT_RE = /^<<<<<<< ours\n([\s\S]*?)^\|\|\|\|\|\|\| base\n[\s\S]*?^=======\n([\s\S]*?)^>>>>>>> theirs[^\n]*\n?/gm;
@@CLEANROOM_HOLE_4@@
  const eol = diff3Text.includes("\r\n") ? "\r\n" : diff3Text.includes("\r") ? "\r" : "\n";
  const normalized = normalizeEol(diff3Text);
@@CLEANROOM_HOLE_5@@
  const resolved = normalized.replace(CONFLICT_RE, (whole: string, ours: string, theirs: string) => {
@@CLEANROOM_HOLE_6@@
  return { conflict: false, text: eol === "\n" ? resolved : resolved.replace(/\n/g, eol) };
@@CLEANROOM_HOLE_7@@
