import type { Step, ToolCall, Trajectory } from "./types.js";

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Turn any supported trajectory JSON into the viewer's (ATIF-shaped) model, or return null. */
export function normalize(raw: unknown): Trajectory | null {
  if (!isObj(raw)) return null;
  if (Array.isArray(raw.steps)) return raw as Trajectory; // ATIF
  if (Array.isArray(raw.messages)) return fromChatLog(raw); // OpenAI-style chat log
  return null;
}

const TOOL_ERROR_RE = /^\s*(error executing|error:|traceback \(most recent call last\))/i;

function parseArgs(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * Chat-log format: { messages: [{role, content, tool_calls?, reasoning_content?, tool_call_id?}],
 * llm_calls: [{model, duration_s, finish_reason, usage}], system_prompt?, usage_total?, ... }.
 * Each assistant message becomes a step (paired in order with llm_calls for metrics); tool results
 * become that step's observation.
 */
function fromChatLog(raw: Obj): Trajectory {
  const calls: Obj[] = Array.isArray(raw.llm_calls) ? raw.llm_calls : [];
  const steps: Step[] = [];
  let lastAgent: Step | undefined;
  let callIdx = 0;
  let cached = 0;
  let cost = 0;
  let hasCost = false;

  if (typeof raw.system_prompt === "string" && raw.system_prompt)
    steps.push({ source: "system", message: raw.system_prompt });

  for (const m of raw.messages as Obj[]) {
    if (!isObj(m)) continue;
    if (m.role === "assistant") {
      const call = calls[callIdx++] ?? {};
      const u: Obj = call.usage ?? {};
      const c = u.prompt_tokens_details?.cached_tokens;
      if (typeof c === "number") cached += c;
      if (typeof u.cost === "number") {
        cost += u.cost;
        hasCost = true;
      }
      const toolCalls: ToolCall[] = (m.tool_calls ?? []).map((tc: Obj) => ({
        tool_call_id: tc.id,
        function_name: tc.function?.name ?? tc.name,
        arguments: parseArgs(tc.function?.arguments ?? tc.arguments),
      }));
      const details = [
        typeof call.duration_s === "number" && `llm ${call.duration_s.toFixed(2)}s`,
        call.finish_reason && `finish ${call.finish_reason}`,
        typeof u.completion_tokens_details?.reasoning_tokens === "number" &&
          `reasoning ${u.completion_tokens_details.reasoning_tokens.toLocaleString("en-US")}`,
      ].filter(Boolean) as string[];
      lastAgent = {
        source: "agent",
        model_name: call.model,
        message: m.content,
        reasoning_content: m.reasoning_content ?? m.reasoning,
        tool_calls: toolCalls,
        metrics: {
          prompt_tokens: u.prompt_tokens,
          completion_tokens: u.completion_tokens,
          cached_tokens: c,
          cost_usd: u.cost,
        },
        details,
      };
      if (!toolCalls.length && (call.finish_reason ?? "stop") === "stop") lastAgent.flags = { complete: "final answer" };
      steps.push(lastAgent);
    } else if (m.role === "tool" && lastAgent) {
      const results = (lastAgent.observation ??= { results: [] }).results!;
      results.push({ source_call_id: m.tool_call_id, content: m.content });
      const text = typeof m.content === "string" ? m.content : "";
      if (TOOL_ERROR_RE.test(text)) lastAgent.flags = { ...lastAgent.flags, error: "tool error" };
    } else {
      steps.push({ source: m.role === "user" ? "user" : String(m.role ?? "message"), message: m.content });
    }
  }
  steps.forEach((s, i) => (s.step_id = i + 1));

  // Only the last "final answer" is the end of the run; earlier text-only replies are just replies.
  const finals = steps.filter((s) => s.flags?.complete);
  for (const s of finals.slice(0, -1)) delete s.flags!.complete;

  const total: Obj = raw.usage_total ?? {};
  const meta: [string, string][] = [];
  if (raw.channel) meta.push(["Channel", String(raw.channel)]);
  if (typeof raw.duration_s === "number") meta.push(["Duration", `${raw.duration_s.toFixed(1)}s`]);
  if (raw.started_at) meta.push(["Started", String(raw.started_at).replace("T", " ").slice(0, 19)]);
  if (typeof raw.history_message_count === "number")
    meta.push(["Prior history", `${raw.history_message_count} msgs (not included)`]);

  const ids = [raw.conversation_id != null && `conversation ${raw.conversation_id}`, raw.message_id != null && `message ${raw.message_id}`];
  return {
    schema_version: raw.version != null ? `chat-log v${raw.version}` : "chat-log",
    session_id: raw.conversation_id != null ? String(raw.conversation_id) : undefined,
    task_name: ids.filter(Boolean).join(" · ") || undefined,
    agent: { model_name: calls.find((c) => c.model)?.model },
    steps,
    final_metrics: {
      total_prompt_tokens: total.prompt_tokens,
      total_completion_tokens: total.completion_tokens,
      total_cached_tokens: cached,
      total_cost_usd: hasCost ? cost : undefined,
      total_steps: steps.length,
    },
    meta,
  };
}
