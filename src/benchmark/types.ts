// Shared contracts for `hunch task benchmark` (Gate A of the context-efficiency plan).
// Design: bench/pilot5/GATE-A-HARNESS.md on the pilot branch; plan section 7.

export type BenchmarkArm = "no-hunch" | "current-hunch" | "optimized-hunch";
export type TokenMeasurement = "provider" | "estimate" | "unavailable";
export type CallMeasurement = "provider" | "parsed" | "unavailable";

export interface TaskCost {
  input_tokens: number | null;
  output_tokens: number | null;
  token_measurement: TokenMeasurement;
  /** Parts of input_tokens as the provider reported them; null when unavailable. */
  input_token_parts: { input: number; cache_creation: number; cache_read: number } | null;
  hunch_context_estimated_tokens: number;
  memory_processing_tokens: number | null;
  model_calls: number | null;
  tool_calls: number | null;
  investigation_tool_calls: number | null;
  call_measurement: CallMeasurement;
  agent_wall_clock_ms: number;
  validation_ms: number;
  total_wall_clock_ms: number;
}

export interface SuiteTask {
  id: string;
  issue_number: number;
  category: "continuation" | "repeated-bug" | "convention" | "operation" | "self-contained";
  /** Exact text given to the agent in both arms (issue title + blank line + body at arrival). */
  prompt: string;
  starting_commit: string;
  memory: {
    cutoff_at: string;
    eligible_record_ids: string[];
    relevance_expected: "relevant" | "abstain" | "unknown";
  };
  validator: {
    /** Path relative to the suite file; copied into <repo>/test/ after the agent exits. */
    file: string;
    sha256: string;
  };
}

export interface BenchmarkSuite {
  schema: "hunch.context-efficiency-suite/1";
  id: string;
  kind: "retrospective" | "prospective";
  timeout_ms: number;
  validator_timeout_ms: number;
  tasks: SuiteTask[];
}

export interface RunnerConfig {
  schema: "hunch.benchmark-runner/1";
  provider: "claude" | "fixture";
  /** Executable name or absolute path. For "fixture": a node script path (tests only). */
  executable: string;
  model: string;
  effort: string | null;
}

export interface RunnerIdentity {
  provider: string;
  cli_version: string;
  sanitized_argv_hash: string;
  model_identity: string | null;
  model_identity_source: "reported" | "configured" | "unknown";
}

/** What the arm-isolation layer hands the runner for one run. */
export interface PreparedArm {
  arm: BenchmarkArm;
  repo: string;
  /** JSON file passed to --mcp-config. */
  mcp_config_path: string;
  /** Extra environment for the child (e.g. HUNCH_PRIVATE_DIR); applied after stripping. */
  env: Record<string, string>;
  /** Characters of Hunch text present before the session starts (grounding blocks, tools/list). */
  static_hunch_chars: Record<string, number>;
  exposure: ExposureProof;
}

export interface ExposureProof {
  arm: BenchmarkArm;
  ok: boolean;
  checks: { id: string; ok: boolean; detail: string }[];
  /** The frozen public snapshot hash, verified against the mount before setup (current-hunch). */
  memory_snapshot_sha256: string | null;
  /** Tracked `.hunch/` hash after the audited writers and `hunch index` ran (current-hunch). */
  post_setup_hunch_sha256: string | null;
}

/** Parsed from a stream-json transcript. */
export interface TranscriptMetrics {
  init: {
    model: string | null;
    api_key_source: string | null;
    mcp_servers: string[];
    /** Server name -> reported status (e.g. "connected", "failed"); bare-string entries carry no status. */
    mcp_server_status: Record<string, string>;
    tool_names: string[];
  } | null;
  result: { subtype: string | null; is_error: boolean | null; num_turns: number | null } | null;
  usage: { input: number; cache_creation: number; cache_read: number; output: number } | null;
  model_usage: Record<string, unknown> | null;
  model_calls: number;
  tool_calls: number;
  tool_histogram: Record<string, number>;
  investigation_tool_calls: number;
  hunch_tool_calls: number;
  /** Characters Hunch injected during the session: mcp__hunch__* results and hook output. */
  hunch_dynamic_chars: { tool_results: number; hooks: number };
  hook_events: number;
  /** Record ids (dec_/con_/fnd_/bug_/htask_) seen in Hunch-injected text. */
  delivered_record_ids: string[];
}

export interface AgentRunResult {
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  agent_wall_clock_ms: number;
  transcript_path: string;
  stderr_path: string;
  metrics: TranscriptMetrics;
}

export interface EfficiencyRun {
  schema: "hunch.context-efficiency-run/1";
  task_id: string;
  arm: BenchmarkArm;
  run_index: number;
  suite_hash: string;
  harness_revision: string;
  audited_hunch_revision: string | null;
  arm_order_seed: string;
  repository_revision: string;
  memory_revision: string | null;
  runner: RunnerIdentity;
  cache_state: "cold" | "warm";
  evidence_kind: "product" | "fixture";
  success: boolean;
  status: "completed" | "timed_out" | "agent_error" | "invalid_exposure" | "isolation_breach";
  quality: {
    outcome: "passed" | "failed" | "partial" | "unavailable";
    validator_id: string;
  };
  cost: TaskCost;
  replay_packet_id: string | null;
  selected_memory_ids: string[];
  delivered_eligible_ids: string[];
  isolation_evidence: string[];
  validation_evidence: string[];
}
