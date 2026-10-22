import type { Step, ToolCall, Trajectory } from "./types.js";

// Converters from other trajectory formats into the viewer's (ATIF-shaped) model.
// Supported: ATIF, chat logs (OpenAI messages + llm_calls), Anthropic Messages content blocks,
// mini-swe-agent (v1 text mode and v2 tool calls) and SWE-agent .traj files.

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Turn any supported trajectory JSON into the viewer's model, or return null. */
export function normalize(raw: unknown): Trajectory | null {
  if (!isObj(raw)) return null;
  if (Array.isArray(raw.steps)) return raw as Trajectory; // ATIF
  if (Array.isArray(raw.trajectory) || Array.isArray(raw.attempts)) return fromSweAgent(raw);
  if (Array.isArray(raw.messages)) {
    if (String(raw.trajectory_format ?? "").startsWith("mini-swe-agent") || raw.info?.mini_version)
      return fromMiniSweAgent(raw);
    return fromChatLog(raw);
  }
  return null;
}

const TOOL_ERROR_RE = /^\s*(error executing|error:|traceback \(most recent call last\))/i;
const MINI_V1_FORMAT_ERROR_RE = /please always provide exactly one action|format error:/i;

function parseArgs(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join("\n");
  if (isObj(v)) return typeof v.text === "string" ? v.text : "";
  return "";
}

function addResult(step: Step, content: unknown, callId?: string): void {
  (step.observation ??= { results: [] }).results!.push({ source_call_id: callId, content });
}

function flag(step: Step, key: "error" | "warning" | "complete", label: string): void {
  step.flags = { ...step.flags, [key]: label };
}

/** Badge for how a run ended: green when the agent submitted, amber otherwise (limits, errors, …). */
function flagExit(step: Step, status: string): void {
  if (/^submitted/i.test(status) || /^(completed|success)$/i.test(status)) flag(step, "complete", status);
  else flag(step, "warning", `exit: ${status}`);
}

interface Totals {
  prompt: number;
  completion: number;
  cached: number;
  cost: number;
  hasCost: boolean;
}

/** Usage numbers from an OpenAI/litellm usage object or an Anthropic one. */
function readUsage(u: Obj | undefined): Step["metrics"] {
  if (!isObj(u)) return undefined;
  const prompt = num(u.prompt_tokens) ?? num(u.input_tokens);
  const cached =
    num(u.prompt_tokens_details?.cached_tokens) ?? num(u.cache_read_input_tokens) ?? num(u.input_tokens_details?.cached_tokens);
  // Anthropic's input_tokens excludes cache reads/writes; add them so "prompt" means the full prompt.
  const fullPrompt =
    u.input_tokens != null && u.prompt_tokens == null
      ? (prompt ?? 0) + (num(u.cache_read_input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0)
      : prompt;
  return {
    prompt_tokens: fullPrompt,
    completion_tokens: num(u.completion_tokens) ?? num(u.output_tokens),
    cached_tokens: cached,
    cost_usd: num(u.cost),
  };
}

/**
 * Epoch timestamp → ISO string. The unit (s, ms, µs or ns) is inferred from the magnitude, since present-day
 * values differ by 1000× per unit. Returns undefined for anything Date can't represent.
 */
export function epochToIso(ts: number | undefined): string | undefined {
  if (ts == null || !Number.isFinite(ts)) return undefined;
  const abs = Math.abs(ts);
  const ms = abs < 1e11 ? ts * 1e3 : abs < 1e14 ? ts : abs < 1e17 ? ts / 1e3 : ts / 1e6;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

function finishSteps(steps: Step[]): Step[] {
  steps.forEach((s, i) => (s.step_id = i + 1));
  return steps;
}

function sumSteps(steps: Step[]): Totals {
  const t: Totals = { prompt: 0, completion: 0, cached: 0, cost: 0, hasCost: false };
  for (const s of steps) {
    const m = s.metrics;
    if (!m) continue;
    t.prompt += m.prompt_tokens ?? 0;
    t.completion += m.completion_tokens ?? 0;
    t.cached += m.cached_tokens ?? 0;
    if (m.cost_usd != null) {
      t.cost += m.cost_usd;
      t.hasCost = true;
    }
  }
  return t;
}

// ---- Generic message walker (OpenAI chat, Anthropic content blocks, mini-swe-agent) ----

interface WalkOptions {
  /** Per-assistant-message call info, paired in order (chat-log `llm_calls`). */
  calls?: Obj[];
  /** mini-swe-agent: user messages after an action are observations / format errors. */
  mini?: boolean;
}

function walkMessages(messages: unknown[], opts: WalkOptions = {}): { steps: Step[]; exitStatus?: string } {
  const steps: Step[] = [];
  let lastAgent: Step | undefined;
  let callIdx = 0;
  let exitStatus: string | undefined;

  for (const m of messages) {
    if (!isObj(m)) continue;
    const extra: Obj = isObj(m.extra) ? m.extra : {};
    const blocks: Obj[] = Array.isArray(m.content) ? m.content.filter(isObj) : [];

    if (m.role === "assistant") {
      const call: Obj = opts.calls?.[callIdx++] ?? {};
      const toolCalls: ToolCall[] = (Array.isArray(m.tool_calls) ? m.tool_calls.filter(isObj) : []).map((tc: Obj) => ({
        tool_call_id: tc.id,
        function_name: tc.function?.name ?? tc.name,
        arguments: parseArgs(tc.function?.arguments ?? tc.arguments),
      }));
      let message: unknown = m.content;
      let reasoning: unknown = m.reasoning_content ?? m.reasoning ?? m.thinking;
      if (blocks.length) {
        // Anthropic-style content blocks
        message = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
        const thinking = blocks.filter((b) => b.type === "thinking" || b.type === "redacted_thinking");
        if (thinking.length) reasoning = thinking.map((b) => b.thinking ?? "[redacted thinking]").join("\n\n");
        for (const b of blocks.filter((b) => b.type === "tool_use"))
          toolCalls.push({ tool_call_id: b.id, function_name: b.name, arguments: b.input });
      }
      if (opts.mini && !toolCalls.length) {
        // mini-swe-agent text mode: v2 stores parsed actions, v1 only has the ```bash block in the text.
        const actions: Obj[] = Array.isArray(extra.actions) ? extra.actions.filter(isObj) : [];
        const cmds = actions.length
          ? actions.map((a) => String(a.command ?? ""))
          : [...textOf(m.content).matchAll(/```(?:bash|sh)?\s*\n([\s\S]*?)\n```/g)].map((x) => x[1]);
        for (const command of cmds) toolCalls.push({ function_name: "bash", arguments: { command } });
      }

      const response: Obj = isObj(extra.response) ? extra.response : {};
      const metrics = readUsage(call.usage ?? m.usage ?? response.usage) ?? {};
      if (metrics.cost_usd == null) metrics.cost_usd = num(extra.cost);
      const details = [
        num(call.duration_s) != null && `llm ${call.duration_s.toFixed(2)}s`,
        (call.finish_reason ?? m.stop_reason ?? response.choices?.[0]?.finish_reason) &&
          `finish ${call.finish_reason ?? m.stop_reason ?? response.choices[0].finish_reason}`,
        num(call.usage?.completion_tokens_details?.reasoning_tokens) != null &&
          `reasoning ${call.usage.completion_tokens_details.reasoning_tokens.toLocaleString("en-US")}`,
      ].filter(Boolean) as string[];

      lastAgent = {
        source: "agent",
        model_name: call.model ?? m.model ?? response.model,
        timestamp: epochToIso(num(extra.timestamp)),
        message,
        reasoning_content: reasoning,
        tool_calls: toolCalls,
        metrics,
        details,
      };
      steps.push(lastAgent);
      continue;
    }

    if (m.role === "tool" && lastAgent) {
      addResult(lastAgent, m.content, m.tool_call_id);
      if (extra.exception_info || TOOL_ERROR_RE.test(textOf(m.content))) flag(lastAgent, "error", "tool error");
      continue;
    }

    if (m.role === "exit") {
      exitStatus = String(extra.exit_status ?? m.content ?? "exit");
      if (!lastAgent) steps.push({ source: "system", message: m.content });
      continue;
    }

    if (m.role === "user" && lastAgent) {
      // Anthropic tool results arrive as user messages made of tool_result blocks.
      const results = blocks.filter((b) => b.type === "tool_result");
      for (const r of results) {
        addResult(lastAgent, r.content, r.tool_use_id);
        if (r.is_error || TOOL_ERROR_RE.test(textOf(r.content))) flag(lastAgent, "error", "tool error");
      }
      if (results.length) {
        const rest = blocks.filter((b) => b.type !== "tool_result");
        if (rest.length) steps.push({ source: "user", message: rest });
        continue;
      }
      if (opts.mini) {
        const text = textOf(m.content);
        if (extra.interrupt_type === "FormatError" || MINI_V1_FORMAT_ERROR_RE.test(text)) {
          addResult(lastAgent, m.content);
          flag(lastAgent, "error", "format error");
          continue;
        }
        if ("returncode" in extra || "raw_output" in extra || /^\s*<(returncode|exception)>/.test(text)) {
          addResult(lastAgent, m.content);
          if (extra.exception_info || /^\s*<exception>/.test(text)) flag(lastAgent, "error", "tool error");
          continue;
        }
      }
    }

    steps.push({ source: m.role === "user" ? "user" : String(m.role ?? "message"), message: m.content });
  }
  return { steps, exitStatus };
}

/** Mark how the run ended: an explicit exit status, else the last text-only assistant reply. */
function markEnding(steps: Step[], exitStatus?: string): void {
  const agents = steps.filter((s) => s.source === "agent");
  const last = agents[agents.length - 1];
  if (!last) return;
  if (exitStatus) flagExit(last, exitStatus);
  else if (!last.tool_calls?.length) flag(last, "complete", "final answer");
}

function systemStep(system: unknown): Step[] {
  const text = textOf(system);
  return text ? [{ source: "system", message: text }] : [];
}

// ---- Chat logs and Anthropic Messages ----

/**
 * { messages: [...], llm_calls?: [{model, duration_s, finish_reason, usage}], system_prompt? | system?,
 *   usage_total?, model?, ... }. Messages may use OpenAI tool_calls or Anthropic content blocks.
 */
function fromChatLog(raw: Obj): Trajectory {
  // Calls are paired with assistant messages in order, so skip calls marked as having produced no
  // message (a provider returning zero choices). Don't infer that from null usage / finish_reason:
  // real calls can have both null.
  const calls: Obj[] = (Array.isArray(raw.llm_calls) ? raw.llm_calls : []).filter(
    (c: unknown) => isObj(c) && !c.no_choices,
  );
  const { steps: walked } = walkMessages(raw.messages, { calls });
  const steps = finishSteps([...systemStep(raw.system_prompt ?? raw.system), ...walked]);
  markEnding(steps);

  const anthropic = (raw.messages as unknown[]).some(
    (m) => isObj(m) && Array.isArray(m.content) && m.content.some((b: Obj) => isObj(b) && /^(tool_use|tool_result|thinking)$/.test(b.type)),
  );
  const t = sumSteps(steps);
  const total: Obj = raw.usage_total ?? {};
  const meta: [string, string][] = [];
  if (raw.channel) meta.push(["Channel", String(raw.channel)]);
  if (num(raw.duration_s) != null) meta.push(["Duration", `${raw.duration_s.toFixed(1)}s`]);
  if (raw.started_at) meta.push(["Started", String(raw.started_at).replace("T", " ").slice(0, 19)]);
  if (num(raw.history_message_count) != null)
    meta.push(["Prior history", `${raw.history_message_count} msgs (not included)`]);

  const ids = [raw.conversation_id != null && `conversation ${raw.conversation_id}`, raw.message_id != null && `message ${raw.message_id}`];
  return {
    schema_version: anthropic ? "anthropic-messages" : raw.version != null ? `chat-log v${raw.version}` : "chat-log",
    session_id: raw.conversation_id != null ? String(raw.conversation_id) : raw.id != null ? String(raw.id) : undefined,
    task_name: ids.filter(Boolean).join(" · ") || undefined,
    agent: { model_name: raw.model ?? calls.find((c) => c.model)?.model ?? steps.find((s) => s.model_name)?.model_name },
    steps,
    final_metrics: {
      total_prompt_tokens: num(total.prompt_tokens) ?? t.prompt,
      total_completion_tokens: num(total.completion_tokens) ?? t.completion,
      total_cached_tokens: t.cached,
      total_cost_usd: t.hasCost ? t.cost : undefined,
      total_steps: steps.length,
    },
    meta,
  };
}

// ---- mini-swe-agent ----

/** { info: {model_stats, config, mini_version, exit_status, submission}, messages: [...], trajectory_format, instance_id? } */
function fromMiniSweAgent(raw: Obj): Trajectory {
  const info: Obj = raw.info ?? {};
  const { steps: walked, exitStatus } = walkMessages(raw.messages, { mini: true });
  const steps = finishSteps(walked);
  markEnding(steps, exitStatus ?? (info.exit_status || undefined));
  if (info.submission) {
    const last = steps.filter((s) => s.source === "agent").pop();
    last?.details?.push(`submission: ${String(info.submission).length.toLocaleString("en-US")} chars`);
  }

  const t = sumSteps(steps);
  const stats: Obj = info.model_stats ?? {};
  const meta: [string, string][] = [];
  if (info.exit_status) meta.push(["Exit", String(info.exit_status)]);
  if (num(stats.api_calls) != null) meta.push(["API calls", String(stats.api_calls)]);
  return {
    schema_version: String(raw.trajectory_format ?? "mini-swe-agent"),
    task_name: raw.instance_id ?? info.instance_id,
    agent: {
      name: "mini-swe-agent",
      version: info.mini_version,
      model_name: info.config?.model?.model_name ?? steps.find((s) => s.model_name)?.model_name,
    },
    steps,
    final_metrics: {
      total_prompt_tokens: t.prompt || undefined,
      total_completion_tokens: t.completion || undefined,
      total_cached_tokens: t.cached || undefined,
      total_cost_usd: num(stats.instance_cost) ?? (t.hasCost ? t.cost : undefined),
      total_steps: steps.length,
    },
    meta,
  };
}

// ---- SWE-agent (.traj) ----

/**
 * { trajectory: [{thought, action, observation, response, execution_time, state, extra_info}],
 *   history: [{role, content, message_type, is_demo?}], info: {model_stats, exit_status, submission, ...},
 *   replay_config: "<json string>", environment }. Retry-loop runs add `attempts: [<same shape>]`.
 */
function fromSweAgent(raw: Obj): Trajectory {
  const last = Array.isArray(raw.attempts) ? raw.attempts[raw.attempts.length - 1] : undefined;
  const run: Obj = Array.isArray(raw.trajectory) ? raw : isObj(last) ? last : {};
  const info: Obj = { ...(isObj(run.info) ? run.info : {}), ...(isObj(raw.info) ? raw.info : {}) };
  const history: Obj[] = (Array.isArray(run.history) ? run.history : []).filter((h: unknown) => isObj(h) && !h.is_demo);
  let replay: Obj = {};
  try {
    const parsed = typeof run.replay_config === "string" ? JSON.parse(run.replay_config) : run.replay_config;
    if (isObj(parsed)) replay = parsed;
  } catch {
    /* not JSON */
  }
  const model = replay.agent?.model?.name ?? replay.agent?.model?.model_name;

  const steps: Step[] = [];
  const sys = history.find((h) => h.role === "system");
  if (sys) steps.push({ source: "system", message: sys.content });
  const task = history.find((h) => h.role === "user");
  if (task) steps.push({ source: "user", message: task.content });

  for (const item of Array.isArray(run.trajectory) ? run.trajectory : []) {
    if (!isObj(item)) continue;
    const thought = textOf(item.thought) || textOf(item.response);
    const step: Step = {
      source: "agent",
      model_name: model,
      message: thought,
      tool_calls: item.action ? [{ function_name: "action", arguments: { command: String(item.action).trimEnd() } }] : [],
      details: num(item.execution_time) != null ? [`exec ${item.execution_time.toFixed(2)}s`] : [],
    };
    if (item.observation != null && item.observation !== "") addResult(step, item.observation);
    const obs = textOf(item.observation);
    if (TOOL_ERROR_RE.test(obs) || /was cancelled because it took more than/i.test(obs)) flag(step, "error", "tool error");
    if (isObj(item.state) && Object.keys(item.state).length) step.extra = { state: item.state };
    steps.push(step);
  }
  finishSteps(steps);
  markEnding(steps, info.exit_status || undefined);

  const stats: Obj = info.model_stats ?? {};
  const meta: [string, string][] = [];
  if (info.exit_status) meta.push(["Exit", String(info.exit_status)]);
  if (num(stats.api_calls) != null) meta.push(["API calls", String(stats.api_calls)]);
  if (Array.isArray(raw.attempts) && raw.attempts.length > 1)
    meta.push([
      "Attempts",
      `${raw.attempts.length} (showing ${run === raw && info.best_attempt_idx != null ? `best, #${info.best_attempt_idx + 1}` : "last"})`,
    ]);
  if (run.environment) meta.push(["Environment", String(run.environment)]);

  return {
    schema_version: "swe-agent traj",
    task_name: replay.problem_statement?.id ?? replay.env?.name,
    agent: { name: "swe-agent", version: info.swe_agent_version, model_name: model },
    steps,
    final_metrics: {
      total_prompt_tokens: num(stats.tokens_sent),
      total_completion_tokens: num(stats.tokens_received),
      total_cost_usd: num(stats.instance_cost),
      total_steps: steps.length,
    },
    meta,
  };
}
