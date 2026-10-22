import { it } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "../src/client/formats.ts";

// Keys the converters read, so random inputs reach deep into every format's code path.
const KEYS = [
  "steps", "messages", "trajectory", "attempts", "llm_calls", "info", "history", "replay_config", "trajectory_format",
  "mini_version", "role", "content", "tool_calls", "function", "arguments", "name", "id", "type", "text", "thinking",
  "input", "tool_use_id", "is_error", "extra", "actions", "command", "response", "usage", "choices", "finish_reason",
  "timestamp", "cost", "prompt_tokens", "completion_tokens", "input_tokens", "prompt_tokens_details", "cached_tokens",
  "model", "model_stats", "exit_status", "submission", "thought", "action", "observation", "execution_time", "state",
  "is_demo", "agent", "problem_statement", "system", "system_prompt", "usage_total", "no_choices", "returncode",
  "exception_info", "interrupt_type", "duration_s", "best_attempt_idx", "config", "model_name", "tool_call_id",
];
const ROLES = ["user", "assistant", "tool", "system", "exit"];
const TYPES = ["text", "thinking", "tool_use", "tool_result", "redacted_thinking"];

/** Small deterministic PRNG (mulberry32) so failures are reproducible from the seed. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gen(r: () => number, depth: number): unknown {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const k = r();
  if (depth <= 0 || k < 0.3)
    return pick<unknown>([null, undefined, 0, -1, 1e30, NaN, 1761000000, true, "", "x", "{", "[]", "Error: boom", pick(ROLES), pick(TYPES)]);
  if (k < 0.55) return Array.from({ length: Math.floor(r() * 4) }, () => gen(r, depth - 1));
  const o: Record<string, unknown> = {};
  for (let i = Math.floor(r() * 5); i > 0; i--) o[pick(KEYS)] = gen(r, depth - 1);
  if (r() < 0.4) o.role = pick(ROLES);
  if (r() < 0.3) o.type = pick(TYPES);
  return o;
}

it("never throws on malformed input (seeded fuzz of every converter)", () => {
  const roots = ["messages", "trajectory", "attempts", "steps"];
  for (let seed = 1; seed <= 20000; seed++) {
    const r = rng(seed);
    const input = gen(r, 5) as Record<string, unknown>;
    // Force a recognised top-level shape most of the time so each converter is exercised.
    if (input && typeof input === "object" && !Array.isArray(input) && r() < 0.8) {
      const root = roots[Math.floor(r() * roots.length)];
      input[root] = Array.from({ length: 1 + Math.floor(r() * 4) }, () => gen(r, 4));
      if (root === "messages" && r() < 0.4) input.trajectory_format = "mini-swe-agent-1.1";
    }
    assert.doesNotThrow(() => normalize(input), `seed ${seed}: ${JSON.stringify(input)}`);
  }
});

it("never throws on known-awkward shapes for each converter", () => {
  const cases: unknown[] = [
    // SWE-agent
    { attempts: [{ trajectory: 1 }] },
    { attempts: [{ usage_total: null }, { usage: 1 }, { trajectory: -1 }] },
    { attempts: [null] },
    { attempts: [{ replay_config: "null", trajectory: [{ action: {} }, null, 3] }] },
    { trajectory: [], info: 5, history: [null, { role: "user" }] },
    // mini-swe-agent
    { trajectory_format: "mini-swe-agent-1.1", messages: [{ role: "assistant", content: "x", extra: { actions: [null, { command: "ls" }] } }] },
    { trajectory_format: "mini-swe-agent-1.1", info: null, messages: [{ role: "assistant", extra: { actions: "x", response: { choices: [null] } } }, { role: "exit" }] },
    { info: { mini_version: "2" }, messages: [{ role: "user", extra: null, content: [null] }] },
    // chat log / Anthropic
    { messages: [{ role: "assistant", content: [{ type: "tool_use" }], usage: 5 }, { role: "user", content: [{ type: "tool_result", content: null }] }] },
    { messages: [], llm_calls: [null, 1, { usage: "x" }], usage_total: 7, system: [null] },
    { messages: [{ role: "assistant", tool_calls: [{ function: null }], extra: { timestamp: "soon" } }], llm_calls: [{ usage: { completion_tokens_details: null } }] },
  ];
  for (const c of cases) assert.doesNotThrow(() => normalize(c), JSON.stringify(c));
});
