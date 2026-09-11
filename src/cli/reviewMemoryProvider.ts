import { resolveSynthesisProvider } from "../synthesis/provider.js";
import { type AgentCliWorker } from "../synthesis/cliAdapter.js";
import { currentInitiator, normalizeInitiator, withInitiator } from "../synthesis/initiator.js";


/** Origin is invocation metadata, never whichever executables happen to be installed. */
export function reviewInitiator(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const supplied = explicit ?? env.HUNCH_REVIEW_INITIATOR;
  if (supplied) {
    return normalizeInitiator(supplied);
  }
  const detected = currentInitiator(env);
  if (!detected.provider) throw new Error("Review initiator is unknown or ambiguous. The calling agent must pass --initiator <name> or HUNCH_INITIATOR; no other account will be selected.");
  return detected.provider;
}

/** One origin-bound provider. Never fail over into another agent's account. */
export function boundReviewGenerator(worker: AgentCliWorker) {
  if (!worker.draftProse) throw new Error("The initiating agent has no usable review generator. No rules were saved.");
  let used = false;
  return {
    name: worker.name,
    providersUsed: () => used ? [worker.name] : [],
    async draftProse(prompt: string): Promise<string> {
      const text = await withInitiator({ provider: worker.name, source: "explicit" }, () => worker.draftProse!(prompt));
      JSON.parse(text);
      used = true;
      return text;
    },
  };
}

export async function chooseReviewGenerator(root: string, configFile?: string, initiator?: string) {
  const name = reviewInitiator(initiator);
  return withInitiator({ provider: name, source: "explicit" }, async () => {
    const selected = await resolveSynthesisProvider({ root, cliConfig: configFile });
    if (selected.provider.name !== name || !selected.provider.draftProse) {
      throw new Error(`Initiating provider ${name} is unavailable. No other account will be selected.`);
    }
    return boundReviewGenerator(selected.provider);
  });
}
