import { cleanupDir } from "./fixtures.js";
@@CLEANROOM_HOLE_1@@
  return { root, cleanup: () => cleanupDir(root) };
@@CLEANROOM_HOLE_2@@
  return { root, headSha: git("rev-parse", "HEAD"), cleanup: () => cleanupDir(root) };
@@CLEANROOM_HOLE_3@@
