import { cleanupDir } from "./fixtures.js";
@@CLEANROOM_HOLE_1@@
  git(root, "config", "gc.auto", "0");
  git(root, "config", "maintenance.auto", "false");
@@CLEANROOM_HOLE_2@@
  return { root, cleanup: () => cleanupDir(root) };
@@CLEANROOM_HOLE_3@@
    cleanupDir(notARepo);
@@CLEANROOM_HOLE_4@@
