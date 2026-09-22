/** HTTP-only response shapes. Verb and record schemas remain in stateContract. */
import { z } from 'zod';
import { CapabilityNegotiationSchema, PrincipalSchema, ReadResponseSchema, ScopeSchema, STATE_CONTRACT_VERSION } from './stateContract.js';
export const HttpCapabilitiesSchema = CapabilityNegotiationSchema.extend({
  repository: ScopeSchema, partitions: z.array(ScopeSchema.shape.kind),
  principal: PrincipalSchema.pick({ id: true, kind: true, grants: true }),
}).strict();
export const HttpHealthSchema = z.object({
  ok: z.boolean(), version: z.string(), protocol: z.literal(STATE_CONTRACT_VERSION),
  // Present only when the request carried a valid credential.
  partitions: z.array(z.string()).optional(),
}).strict();
// Delivery has its own richer assertion and receipt checks in delivery.ts.
export const HttpReadResponseSchema = ReadResponseSchema.extend({ envelope: z.record(z.string(), z.unknown()) });
export const StateProblemSchema = z.object({
  type: z.string(), title: z.string(), status: z.number().int(), detail: z.string(),
  conflict: z.object({ incumbent_id: z.string(), reason: z.string() }).optional(), issues: z.array(z.string()).optional(),
});
