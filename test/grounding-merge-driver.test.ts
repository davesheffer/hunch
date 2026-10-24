import { cleanupDir } from "./fixtures.js";
@@CLEANROOM_HOLE_1@@
import { hunchAttributesAreSafe } from "../src/core/overlaySafety.js";
@@CLEANROOM_HOLE_2@@
import { OVERLAY_ATTRIBUTES } from "../tooling/matrix-release-verification.mjs";
@@CLEANROOM_HOLE_3@@
    cleanupDir(dir);
@@CLEANROOM_HOLE_4@@
    assert.equal(attrs, OVERLAY_ATTRIBUTES,
      "Matrix release verification must recognize the exact installed attributes; update its expectation when routing changes");
@@CLEANROOM_HOLE_5@@
    cleanupDir(root);
@@CLEANROOM_HOLE_6@@
  assert.equal(res.text.replace(/\r\n/g, "").includes("\n"), false, "resolved CRLF text retains its line endings");
@@CLEANROOM_HOLE_7@@
    cleanupDir(dir);
@@CLEANROOM_HOLE_8@@
    cleanupDir(root);
@@CLEANROOM_HOLE_9@@
    cleanupDir(root);
@@CLEANROOM_HOLE_10@@


test("installed grounding attributes permit private capture without permitting arbitrary transforms", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-grounding-attribute-safety-"));
  try {
    git(root, "init", "-q");
    installMergeDriver(root, "hunch");
    const attrs = readFileSync(join(root, ".gitattributes"), "utf8");
    assert.equal(hunchAttributesAreSafe(attrs), true, "the installer's exact rules must allow private capture");
    for (const unsafe of [
      "*.json merge=hunch-grounding", "AGENTS.md filter=evil", "AGENTS.md merge=evil",
      "AGENTS.md merge=hunch-grounding filter=evil", "*.json text eol=crlf",
      "AGENTS.md working-tree-encoding=UTF-16", "*.md merge=hunch-grounding",
    ]) assert.equal(hunchAttributesAreSafe(attrs + unsafe + "\n"), false, unsafe);
  } finally { cleanupDir(root); }
});
