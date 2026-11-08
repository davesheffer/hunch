import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { hunchPaths } from "../core/paths.js";
import { HunchStore } from "../store/hunchStore.js";
import { pullHunchStatusDetailed, type HunchPullStatus, type HunchPullFailureDetail } from "../extractors/git.js";
import { ensureTeamOverlay, readTeamConfig, isTeamStoreTrusted, teamWiringConsented, untrustedTeamStoreMessage, overlayMatchesTeamRemote, advertisedTeamRemoteContract } from "../integrations/team.js";
import { pinSharedRemote } from "../integrations/sharedRoute.js";

let openStore: HunchStore | null = null;

/** The store the last `openTeamStore` left open (closed by the entry's catch). */
export function trackedStore(): HunchStore | null { return openStore; }
/** Forget the tracked store once its caller has closed it. */
export function clearTrackedStore(): void { openStore = null; }

export type TeamStoreOptions = { requireFreshTeamMemory?: boolean };

export function openTeamStore(root: string, opts: TeamStoreOptions = {}): {
  store: HunchStore;
  teamWired: string | null;
  teamPullStatus: HunchPullStatus | null;
  teamPullDetail?: HunchPullFailureDetail;
} {
  // A committed team.json is an explicit declaration that this checkout belongs
  // to a shared memory graph. Once that declaration exists, silently falling back
  // to public `.hunch/` on an invalid config, offline first clone, or dead pointer
  // would turn a missing team rule into a false pass (and could publish a first
  // write in the code repository). An explicit HUNCH_PRIVATE_DIR remains the
  // documented per-process override and therefore owns its own availability.
  const explicitOverlay = !!process.env.HUNCH_PRIVATE_DIR?.trim();
  const teamFile = join(hunchPaths(root).hunch, "team.json");
  const teamAdvertised = !explicitOverlay && existsSync(teamFile);
  const advertisedTeam = teamAdvertised ? readTeamConfig(root) : null;
  if (teamAdvertised && !advertisedTeam) {
    throw new Error(".hunch/team.json is invalid or unsafe; refusing to fall back to public memory");
  }

  const teamWired = ensureTeamOverlay(root);
  const store = new HunchStore(hunchPaths(root));
  openStore = store;
  const overlayWarning = store.overlayResolutionWarning(explicitOverlay && existsSync(teamFile));
  if (overlayWarning) console.error(`[hunch] ⚠ ${overlayWarning}`);
  if (advertisedTeam && (store.mode !== "shared"
    || !store.privateDir
    || !existsSync(store.privateDir)
    || !teamWiringConsented(root, advertisedTeam, store.privateDir)
    || !overlayMatchesTeamRemote(root, dirname(store.privateDir)))) {
    const consented = !!store.privateDir && teamWiringConsented(root, advertisedTeam, store.privateDir);
    store.close();
    openStore = null;
    if (!consented && !isTeamStoreTrusted(root, advertisedTeam)) throw new Error(untrustedTeamStoreMessage(advertisedTeam));
    throw new Error("the advertised team memory store is unavailable or tracks a different remote; refusing to read or write another graph");
  }

  // Short-lived CLI processes need the same live edge as the long-lived MCP
  // server. Refresh once at command start. Ordinary reads/writes can continue
  // from their durable local overlay when the network is temporarily down, but a
  // strict guard must prove it saw the advertised remote before it may pass.
  let pullStatus: HunchPullStatus | null = null;
  let pullDetail: HunchPullFailureDetail | undefined;
  if (teamAdvertised && store.mode === "shared" && store.privateDir) {
    const remote = advertisedTeamRemoteContract(root, dirname(store.privateDir));
    if (!remote || !remote.verify()) {
      store.close();
      openStore = null;
      throw new Error("the advertised team memory route could not be pinned for this command");
    }
    pinSharedRemote(store, remote);
    ({ status: pullStatus, detail: pullDetail } = pullHunchStatusDetailed(store.privateDir, {
      remote,
    }));
    // The route may be coherently rewritten while the bounded pull is blocked.
    // No handler — including an ordinary non-strict read — may run after the
    // graph epoch that admitted this command stops verifying.
    if (!remote.verify()) {
      store.close();
      openStore = null;
      throw new Error("the advertised team memory route changed while this command was refreshing; refusing to serve or mutate stale memory");
    }
  }
  return { store, teamWired, teamPullStatus: opts.requireFreshTeamMemory ? pullStatus : null, teamPullDetail: opts.requireFreshTeamMemory ? pullDetail : undefined };
}
