// Trajectory model the viewer renders. It follows ATIF (only the fields the viewer reads, all optional
// to tolerate variants). Other formats are converted into it; see formats.ts.

export interface ToolCall {
  tool_call_id?: string;
  function_name?: string;
  arguments?: unknown;
}

export interface ObservationResult {
  source_call_id?: string | null;
  content?: unknown;
}

export interface Step {
  step_id?: number;
  timestamp?: string;
  source?: string;
  model_name?: string;
  message?: unknown;
  reasoning_content?: unknown;
  tool_calls?: ToolCall[];
  observation?: { results?: ObservationResult[] };
  metrics?: { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number; cost_usd?: number };
  error?: unknown;
  extra?: Record<string, unknown>;
  /** Viewer-only: badge labels set by a format converter, overriding the ATIF heuristics. */
  flags?: { error?: string; warning?: string; complete?: string };
  /** Viewer-only: extra "key value" bits shown in the step's footer line. */
  details?: string[];
}

export interface Trajectory {
  schema_version?: string;
  session_id?: string;
  task_name?: string;
  agent?: { name?: string; version?: string; model_name?: string; extra?: Record<string, unknown> };
  steps?: Step[];
  final_metrics?: {
    total_prompt_tokens?: number;
    total_completion_tokens?: number;
    total_cached_tokens?: number;
    total_cost_usd?: number;
    total_steps?: number;
  };
  extra?: Record<string, unknown>;
  /** Viewer-only: extra header fields, shown before "Session". */
  meta?: [string, string][];
}
