/**
 * The shared-memory route a Store instance was admitted under. Apart from sync.ts
 * (which pulls in the grounding writers) so the hook entry can pin a route without them.
 */
import { dirname } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import type { HunchRemoteContract } from "../extractors/git.js";
import { advertisedTeamRemoteContract } from "./team.js";

const pinnedSharedRoutes = new WeakMap<HunchStore, HunchRemoteContract>();

/** Bind one command/server Store instance to the graph epoch that admitted it.
 * Every later flush from that instance reuses the same verifying contract. */
export function pinSharedRemote(store: HunchStore, remote: HunchRemoteContract): void {
  pinnedSharedRoutes.set(store, remote);
}

/** Return the route admitted for this Store instance. Command paths that flush
 * directly (rather than through flushCapture) must use this accessor too, or a
 * coherent team.json/origin rewrite could switch graphs mid-command. */
export function sharedRemoteFor(store: HunchStore): HunchRemoteContract | undefined {
  if (store.mode !== "shared" || !store.privateDir) return undefined;
  return pinnedSharedRoutes.get(store)
    ?? advertisedTeamRemoteContract(store.publicRoot, dirname(store.privateDir));
}
