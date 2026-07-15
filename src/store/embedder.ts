/**
 * Pluggable embedder for the semantic-search READ path (DESIGN.md §6 — the
 * "add embeddings once keyword search proves insufficient" upgrade).
 *
 * Embeddings are LOCAL and FREE. Anthropic has no embeddings endpoint and the
 * project avoids implicit metered inference (see synthesis/provider.ts), so we run a small
 * sentence-transformer locally via transformers.js. That library is an OPTIONAL
 * dependency, dynamically imported — if it isn't installed, `selectEmbedder()`
 * returns null and the whole feature degrades to pure FTS (the lean-install
 * default). This mirrors the synthesis provider: an interface so callers never
 * know which implementation ran, plus a deterministic stub for tests.
 *
 * Vectors are L2-NORMALIZED, so cosine similarity == dot product downstream.
 */
import { createRequire } from "node:module";

export interface Embedder {
  /** Embed each text → an L2-normalized Float32Array of length `dim`. */
  embed(texts: string[]): Promise<Float32Array[]>;
  readonly dim: number;
  /** Stable id; also the `embeddings.model` key, so vectors from different models
   *  never get compared. */
  readonly id: string;
}

// The transformers.js package was renamed @xenova → @huggingface at v3. Probe both.
const PACKAGES = ["@huggingface/transformers", "@xenova/transformers"];
const HF_MODEL = "Xenova/all-MiniLM-L6-v2"; // 384-dim MiniLM; quantized ~23MB

/** Is one of the transformers packages resolvable WITHOUT executing it? Cheap
 *  availability probe (no onnxruntime init) so `selectEmbedder()` can return null
 *  fast on the lean install. */
function installedPackage(): string | null {
  const req = createRequire(import.meta.url);
  for (const p of PACKAGES) {
    try {
      req.resolve(p);
      return p;
    } catch {
      /* not installed — try next */
    }
  }
  return null;
}

export class TransformersEmbedder implements Embedder {
  readonly dim = 384;
  readonly id = "all-MiniLM-L6-v2";
  private extractor: Promise<(texts: string[], opts: unknown) => Promise<{ data: Float32Array }>> | null = null;

  private load() {
    if (!this.extractor) {
      const p = (async () => {
        const pkg = installedPackage();
        if (!pkg) throw new Error("transformers.js not installed");
        // String var (not a literal) so tsc doesn't require the optional dep to be
        // present to typecheck/build, and the import resolves at runtime when it is.
        // transformers.js logs only via an opt-in progress_callback (which we never
        // pass) and onnxruntime warns to stderr, so the model load never writes to
        // stdout — safe for the MCP JSON-RPC stdio channel without redirecting it.
        const mod = (await import(pkg)) as { pipeline: (task: string, model: string, opts?: unknown) => Promise<unknown> };
        // Pin dtype to fp32 (the lib's default for this model): silences the
        // "dtype not specified … using the default dtype (fp32)" line the lib
        // prints to stderr on every load (it leaked into `hunch query` output),
        // and guarantees the numbers stay consistent with vectors already
        // persisted under this model id — changing dtype would shift them.
        return (await mod.pipeline("feature-extraction", HF_MODEL, { dtype: "fp32" })) as (
          texts: string[],
          opts: unknown,
        ) => Promise<{ data: Float32Array }>;
      })();
      this.extractor = p;
      // Never cache a REJECTED load: a transient failure (network blip during the
      // first model download, a missing/incompatible native backend) must not poison
      // the embedder for the rest of a long-lived (MCP) process. Reset so the next
      // call retries from scratch.
      p.catch(() => { if (this.extractor === p) this.extractor = null; });
    }
    return this.extractor;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const extractor = await this.load();
    // pooling:mean + normalize:true → a [n, dim] tensor; .data is one flat
    // Float32Array of length n*dim. Slice per row to a TIGHT copy (the tensor
    // backing buffer is shared — a subarray view would alias it).
    const res = await extractor(texts, { pooling: "mean", normalize: true });
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      out.push(res.data.slice(i * this.dim, (i + 1) * this.dim));
    }
    return out;
  }
}

/** Deterministic, dependency-free embedder for tests (no model download).
 *  Bag-of-token-hashes → L2-normalized vector: shared tokens ⇒ similar vectors,
 *  enough to exercise hybrid ranking without semantics. Intentionally returns
 *  SUBARRAY VIEWS into one backing buffer, so any caller that fails to copy
 *  tightly before persisting will corrupt data — that keeps the BLOB round-trip
 *  honest. */
export class StubEmbedder implements Embedder {
  readonly id = "stub-v1";
  constructor(readonly dim = 32) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    const backing = new Float32Array(texts.length * this.dim);
    const out: Float32Array[] = [];
    texts.forEach((t, row) => {
      const off = row * this.dim;
      for (const tok of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let h = 2166136261;
        for (let i = 0; i < tok.length; i++) {
          h ^= tok.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        const idx = off + ((h >>> 0) % this.dim);
        backing[idx] = (backing[idx] ?? 0) + 1;
      }
      let norm = 0;
      for (let i = 0; i < this.dim; i++) norm += (backing[off + i] ?? 0) ** 2;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < this.dim; i++) backing[off + i] = (backing[off + i] ?? 0) / norm;
      out.push(backing.subarray(off, off + this.dim)); // view, not copy (on purpose)
    });
    return out;
  }
}

/** Choose an embedder, or null to signal "no semantic search → use pure FTS".
 *  Never throws. `HUNCH_EMBEDDER=stub` forces the test stub; `=none` forces the
 *  null (FTS-only) path; otherwise use the local model iff its optional dep is
 *  installed. */
export async function selectEmbedder(): Promise<Embedder | null> {
  switch (process.env.HUNCH_EMBEDDER) {
    case "stub":
      return new StubEmbedder();
    case "none":
      return null;
  }
  return installedPackage() ? new TransformersEmbedder() : null;
}
