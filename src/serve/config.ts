import { ProofPublicKeySchema, PublicOriginSchema, type ProofPublicKey } from '../core/stateProof.js';
/**
 * `hunch serve` configuration — the served partitions and the principals allowed in.
 *
 * A partition is a directory holding a `.hunch/` store whose `.hunch/partition.json`
 * names the scope it IS (organization / team / user / repository). A principal is a
 * bearer token (stored as a sha256 hash — plaintext is printed once by `serve init`)
 * bound to a principal id, kind and grants. The request body never carries a principal:
 * the token resolves it, and grants are decided from this file, never from the caller.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../core/io.js";
import { ScopeSchema, PartitionDeclarationSchema, scopePath, type Principal, type Scope } from "../core/stateContract.js";

export const SERVE_CONFIG_VERSION = "nuryel.serve-config/1" as const;

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;

export const PartitionConfigSchema = z.object({
  scope: ScopeSchema,
  /** Directory whose `.hunch/` holds the partition. Relative paths resolve from the config file. */
  root: z.string().min(1),
}).strict();
export type PartitionConfig = z.infer<typeof PartitionConfigSchema>;

export const PrincipalConfigSchema = z.object({
  proof_key: ProofPublicKeySchema.optional(),
  id: z.string().regex(TOKEN),
  kind: z.enum(["human", "agent", "service"]),
  display: z.string().max(256).optional(),
  /** sha256 hex of the bearer token. */
  token_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  grants: z.array(ScopeSchema).min(1).max(64),
}).strict();
export type PrincipalConfig = z.infer<typeof PrincipalConfigSchema>;

export const ServeConfigSchema = z.object({
  public_origin: PublicOriginSchema.optional(),
  schema: z.literal(SERVE_CONFIG_VERSION),
  port: z.number().int().min(1).max(65535).default(7474),
  partitions: z.array(PartitionConfigSchema).min(1).max(256),
  principals: z.array(PrincipalConfigSchema).max(1024).default([]),
 }).strict().superRefine((config, ctx) => {
  if (config.principals.some(p => p.proof_key) && !config.public_origin) ctx.addIssue({ code: 'custom', message: 'key-bound principals require public_origin for the HTTPS reverse proxy' });
});

export type ServeConfig = z.infer<typeof ServeConfigSchema>;

export const PARTITION_GITIGNORE = [
  "# hunch serve partition — derived runtime artifacts (regenerable from .hunch/*.json)",
  ".hunch/*.sqlite", ".hunch/*.sqlite-shm", ".hunch/*.sqlite-wal", ".hunch/*.sqlite-journal",
  ".hunch/**/*.tmp*", ".hunch/write.lock", ".hunch/.hunch-commit.lock", ".hunch/local.json", ".hunch/events.log", "",
].join("\n");

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function mintToken(): string {
  return `nyt_${randomBytes(24).toString("base64url")}`;
}

export function readServeConfig(file: string): ServeConfig & { file: string } {
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const config = ServeConfigSchema.parse(raw);
  const base = dirname(resolve(file));
  const partitions = config.partitions.map((p) => ({ ...p, root: resolve(base, p.root) }));
  const seen = new Set<string>();
  for (const p of partitions) {
    const key = scopePath(p.scope);
    if (seen.has(key)) throw new Error(`serve config lists partition ${key} twice`);
    seen.add(key);
  }
  const ids = new Set<string>();
  for (const p of config.principals) {
    if (ids.has(p.id)) throw new Error(`serve config lists principal ${p.id} twice`);
    ids.add(p.id);
    for (const g of p.grants) if (!seen.has(scopePath(g))) throw new Error(`principal ${p.id} is granted ${scopePath(g)}, which this server does not serve`);
  }
  return { ...config, partitions, file: resolve(file) };
}

export function writeServeConfig(file: string, config: ServeConfig): void {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileAtomic(resolve(file), JSON.stringify(ServeConfigSchema.parse(config), null, 2) + "\n");
}

/** Constant-time token → principal. Undefined for a missing or unknown token. */
export function resolveCredential(config: ServeConfig, token: string | undefined): PrincipalConfig | undefined {
  if (!token) return undefined;
  const hash = Buffer.from(hashToken(token), "hex");
  for (const p of config.principals) {
    const candidate = Buffer.from(p.token_sha256, "hex");
    if (candidate.length === hash.length && timingSafeEqual(candidate, hash)) {
      return p;
    }
  }
  return undefined;
}

/** Legacy bearer callers cannot resolve a key-bound credential without proof. */
export function resolvePrincipal(config: ServeConfig, token: string | undefined): Principal | undefined {
  const p = resolveCredential(config, token);
  return p && !p.proof_key ? { id: p.id, kind: p.kind, ...(p.display ? { display: p.display } : {}), grants: p.grants } : undefined;
}

export function partitionFor(config: ServeConfig, scope: Scope): PartitionConfig | undefined {
  return config.partitions.find((p) => scopePath(p.scope) === scopePath(scope));
}

/** `serve init`: ensure a partition directory declares its scope, and add a principal
 *  with a freshly minted token. Idempotent for the partition; a principal id that
 *  already exists gets a NEW token (rotation), the old one stops working. */
export function initServeConfig(opts: { file: string; scope: Scope; root: string; principal?: { id: string; kind: "human" | "agent" | "service"; grants?: Scope[]; proofKey?: ProofPublicKey }; publicOrigin?: string; port?: number }): { config: ServeConfig; token: string | null; partition: PartitionConfig } {
  const file = resolve(opts.file);
  const existing = existsSync(file) ? readServeConfig(file) : null;
  const publicOrigin = opts.publicOrigin ?? existing?.public_origin;
  if (publicOrigin) PublicOriginSchema.parse(publicOrigin);
  const proofKey = opts.principal?.proofKey ?? existing?.principals.find(p => p.id === opts.principal?.id)?.proof_key;
  if (proofKey) { ProofPublicKeySchema.parse(proofKey); if (!publicOrigin) throw new Error("key-bound principals require an HTTPS public origin"); }
  // Refuse before writing anything: a grant must name a partition this config will serve.
  const served = new Set([...(existing?.partitions ?? []).map((p) => scopePath(p.scope)), scopePath(opts.scope)]);
  for (const g of opts.principal?.grants ?? []) if (!served.has(scopePath(g))) throw new Error(`cannot grant ${scopePath(g)}: this server does not serve it`);
  const root = resolve(opts.root);
  const hunchDir = resolve(root, ".hunch");
  mkdirSync(hunchDir, { recursive: true });
  const partitionFile = resolve(hunchDir, "partition.json");
  if (existsSync(partitionFile)) {
    const declared = PartitionDeclarationSchema.parse(JSON.parse(readFileSync(partitionFile, "utf8")));
    if (scopePath(declared) !== scopePath(opts.scope)) throw new Error(`${root} already declares partition ${scopePath(declared)}, not ${scopePath(opts.scope)}`);
  } else {
    writeFileAtomic(partitionFile, JSON.stringify(opts.scope, null, 2) + "\n");
  }
  const manifest = resolve(hunchDir, "manifest.json");
  if (!existsSync(manifest)) writeFileAtomic(manifest, JSON.stringify({ schema_version: 3 }, null, 2) + "\n");
  // A served partition is meant to be its own git repository: keep the derived index, temp
  // files and locks out of it so every auto-commit is records + ledger only.
  const ignore = resolve(root, ".gitignore");
  if (!existsSync(ignore)) writeFileAtomic(ignore, PARTITION_GITIGNORE);
  const partitions = existing ? existing.partitions.filter((p) => scopePath(p.scope) !== scopePath(opts.scope)) : [];
  const partition: PartitionConfig = { scope: opts.scope, root };
  partitions.push(partition);
  let principals = existing?.principals ?? [];
  let token: string | null = null;
  if (opts.principal) {
    token = mintToken();
    const grants = opts.principal.grants?.length ? opts.principal.grants : [opts.scope];
    principals = [...principals.filter((p) => p.id !== opts.principal!.id), { id: opts.principal.id, kind: opts.principal.kind, ...(proofKey ? { proof_key: proofKey } : {}), token_sha256: hashToken(token), grants }];
  }
  const config: ServeConfig = { ...(publicOrigin ? { public_origin: publicOrigin } : {}), schema: SERVE_CONFIG_VERSION, port: opts.port ?? existing?.port ?? 7474, partitions, principals };
  writeServeConfig(file, config);
  return { config, token, partition };
}
