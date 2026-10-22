import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { epochToIso, normalize } from "../src/client/formats.ts";
import type { Step, Trajectory } from "../src/client/types.ts";

const load = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

function convert(name: string): Trajectory {
  const traj = normalize(load(name));
  assert.ok(traj, `${name} should be recognised`);
  return traj;
}

const steps = (t: Trajectory): Step[] => t.steps ?? [];
const agents = (t: Trajectory) => steps(t).filter((s) => s.source === "agent");
const obsText = (s: Step) => (s.observation?.results ?? []).map((r) => String(r.content)).join("\n");
/** Step ids carrying each flag, e.g. { error: [5], complete: [6] }. */
function flagged(t: Trajectory): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const s of steps(t))
    for (const [k, v] of Object.entries(s.flags ?? {})) if (v) (out[k] ??= []).push(s.step_id!);
  return out;
}

describe("normalize", () => {
  it("rejects things that are not trajectories", () => {
    for (const v of [null, 42, "x", [], {}, { foo: 1 }]) assert.equal(normalize(v), null);
  });

  it("tolerates malformed entries instead of throwing", () => {
    const t = normalize({ messages: [null, { role: "assistant", tool_calls: [null, { id: "x", function: { name: "bash", arguments: "{" } }] }] });
    assert.deepEqual(t?.steps?.[0].tool_calls, [{ tool_call_id: "x", function_name: "bash", arguments: "{" }]);
  });
});

describe("ATIF", () => {
  it("passes the file through unchanged", () => {
    const raw = load("atif.json");
    assert.equal(normalize(raw), raw);
    const t = convert("atif.json");
    assert.equal(t.schema_version, "ATIF-v1.7");
    assert.equal(steps(t).length, 14);
    assert.equal(t.final_metrics?.total_prompt_tokens, 108677);
  });
});

describe("chat log (messages + llm_calls)", () => {
  const t = convert("chat-log.json");

  it("builds system, task and one step per assistant message", () => {
    assert.deepEqual(
      steps(t).map((s) => s.source),
      ["system", "user", "agent", "agent", "agent"],
    );
    assert.deepEqual(steps(t).map((s) => s.step_id), [1, 2, 3, 4, 5]);
    assert.equal(t.task_name, "conversation 3 · message 7");
    assert.equal(t.agent?.model_name, "deepseek/deepseek-v4.1-flash");
  });

  it("parses tool-call arguments and attaches tool results", () => {
    const [first] = agents(t);
    assert.deepEqual(first.tool_calls, [{ tool_call_id: "c1", function_name: "bash", arguments: { command: "gh pr view 1" } }]);
    assert.equal(first.reasoning_content, "Look at the PR.");
    assert.match(obsText(first), /state: OPEN/);
  });

  it("skips llm_calls that produced no message when pairing metrics", () => {
    const m = agents(t).map((s) => [s.metrics?.prompt_tokens, s.metrics?.completion_tokens, s.metrics?.cost_usd]);
    assert.deepEqual(m, [
      [100, 10, 0.1],
      [200, 20, 0.2],
      [300, 30, 0.3],
    ]);
    assert.ok(agents(t)[1].details?.includes("llm 2.00s"), "the no-choices call's 9.9s must not be attributed");
    assert.ok(Math.abs((t.final_metrics?.total_cost_usd ?? 0) - 0.6) < 1e-9);
    assert.equal(t.final_metrics?.total_cached_tokens, 450);
  });

  it("uses usage_total for the header totals", () => {
    assert.equal(t.final_metrics?.total_prompt_tokens, 600);
    assert.equal(t.final_metrics?.total_completion_tokens, 60);
  });

  it("flags failed tool calls and the final answer", () => {
    assert.deepEqual(flagged(t), { error: [4], complete: [5] });
    assert.equal(steps(t)[4].flags?.complete, "final answer");
  });

  it("adds run details to the header", () => {
    const meta = Object.fromEntries(t.meta ?? []);
    assert.equal(meta.Channel, "web");
    assert.equal(meta.Duration, "12.5s");
    assert.equal(meta["Prior history"], "2 msgs (not included)");
  });
});

describe("Anthropic Messages", () => {
  const t = convert("anthropic.json");

  it("is labelled as Anthropic and keeps the top-level system prompt", () => {
    assert.equal(t.schema_version, "anthropic-messages");
    assert.equal(t.agent?.model_name, "claude-sonnet-4-5");
    assert.deepEqual(steps(t)[0], { source: "system", message: "You are a coding agent.", step_id: 1 });
  });

  it("splits content blocks into message, reasoning and tool calls", () => {
    const [first] = agents(t);
    assert.equal(first.message, "Running the tests.");
    assert.equal(first.reasoning_content, "I should run the tests first.");
    assert.deepEqual(first.tool_calls, [{ tool_call_id: "tu1", function_name: "bash", arguments: { command: "pytest -q" } }]);
  });

  it("attaches tool_result blocks and keeps extra user text as its own step", () => {
    const [, second] = agents(t);
    assert.deepEqual(second.observation?.results?.[0].content, [{ type: "text", text: "ok" }]);
    assert.deepEqual(
      steps(t).map((s) => s.source),
      ["system", "user", "agent", "agent", "user", "agent"],
    );
  });

  it("counts cache reads as prompt tokens", () => {
    assert.deepEqual(agents(t)[0].metrics, { prompt_tokens: 950, completion_tokens: 80, cached_tokens: 900, cost_usd: undefined });
    assert.equal(t.final_metrics?.total_prompt_tokens, 3100);
  });

  it("flags is_error results and the final answer", () => {
    assert.deepEqual(flagged(t), { error: [3], complete: [6] });
  });
});

describe("mini-swe-agent v2 (tool calls)", () => {
  const t = convert("mini-v2.traj.json");

  it("reads run info", () => {
    assert.equal(t.task_name, "django__django-11099");
    assert.equal(t.agent?.name, "mini-swe-agent");
    assert.equal(t.agent?.version, "2.4.6");
    assert.equal(t.agent?.model_name, "anthropic/claude-sonnet-4-5");
    assert.equal(t.final_metrics?.total_cost_usd, 0.0421);
    assert.equal(Object.fromEntries(t.meta ?? []).Exit, "Submitted");
  });

  it("reads per-call usage from extra.response", () => {
    assert.deepEqual(agents(t)[0].metrics, { prompt_tokens: 1200, completion_tokens: 40, cached_tokens: 1100, cost_usd: 0.01 });
    assert.equal(agents(t)[0].timestamp, "2025-10-20T22:40:00.000Z");
  });

  it("flags format errors, command exceptions and the exit status", () => {
    assert.deepEqual(flagged(t), { error: [4, 5], complete: [6] });
    assert.equal(steps(t)[3].flags?.error, "format error");
    assert.equal(steps(t)[4].flags?.error, "tool error");
    assert.equal(steps(t)[5].flags?.complete, "Submitted");
  });

  it("does not turn the exit message into a step", () => {
    assert.ok(!steps(t).some((s) => s.source === "exit"));
  });
});

describe("mini-swe-agent v1 (text mode)", () => {
  const t = convert("mini-v1.traj.json");

  it("extracts the bash block as the command and attaches observations", () => {
    const [first, second] = agents(t);
    assert.deepEqual(first.tool_calls, [{ function_name: "bash", arguments: { command: "ls -la" } }]);
    assert.match(obsText(first), /<returncode>0<\/returncode>/);
    assert.equal(second.tool_calls?.length, 2);
  });

  it("flags format errors and a non-submitted exit as a warning", () => {
    assert.deepEqual(flagged(t), { error: [4], warning: [5] });
    assert.equal(steps(t)[4].flags?.warning, "exit: LimitsExceeded");
  });

  it("leaves token totals unset when the file has none", () => {
    assert.equal(t.final_metrics?.total_prompt_tokens, undefined);
    assert.equal(t.final_metrics?.total_cost_usd, 3.01);
  });
});

describe("SWE-agent .traj", () => {
  const t = convert("swe-agent.traj");

  it("reads model and instance from replay_config", () => {
    assert.equal(t.task_name, "sympy__sympy-20590");
    assert.equal(t.agent?.model_name, "claude-3-7-sonnet-20250219");
    assert.equal(t.agent?.version, "1.1.0");
  });

  it("skips demonstrations and uses the first real user message as the task", () => {
    assert.deepEqual(
      steps(t).map((s) => s.source),
      ["system", "user", "agent", "agent", "agent"],
    );
    assert.match(String(steps(t)[1].message), /Symbol instances have __dict__/);
  });

  it("maps thought / action / observation", () => {
    const [first] = agents(t);
    assert.equal(first.message, "Let me find Symbol.");
    assert.deepEqual(first.tool_calls, [{ function_name: "action", arguments: { command: "find_file symbol.py" } }]);
    assert.match(obsText(first), /Found 1 matches/);
    assert.deepEqual(first.extra, { state: { open_file: "n/a", working_dir: "/testbed" } });
  });

  it("flags timeouts and the submitted exit", () => {
    assert.deepEqual(flagged(t), { error: [4], complete: [5] });
  });

  it("uses model_stats for totals", () => {
    assert.equal(t.final_metrics?.total_prompt_tokens, 210000);
    assert.equal(t.final_metrics?.total_completion_tokens, 3100);
    assert.equal(t.final_metrics?.total_cost_usd, 0.53);
  });
});

describe("SWE-agent retry loop (attempts only)", () => {
  const t = convert("swe-agent-attempts.traj");

  it("shows the last attempt", () => {
    assert.equal(agents(t)[0].message, "second try");
    assert.equal(Object.fromEntries(t.meta ?? []).Attempts, "2 (showing last)");
    assert.equal(t.task_name, "pallets__flask-4045");
    assert.deepEqual(flagged(t), { complete: [3] });
  });
});

describe("epochToIso", () => {
  it("infers seconds, milliseconds, microseconds and nanoseconds", () => {
    for (const ts of [1761000000, 1761000000000, 1761000000000000, 1761000000000000000])
      assert.equal(epochToIso(ts), "2025-10-20T22:40:00.000Z", String(ts));
    assert.equal(epochToIso(1761000000.5), "2025-10-20T22:40:00.500Z");
  });

  it("returns undefined instead of throwing for unusable values", () => {
    for (const ts of [undefined, NaN, Infinity, 1e30]) assert.equal(epochToIso(ts), undefined, String(ts));
  });

  it("does not let a bad timestamp break conversion", () => {
    const raw = load("mini-v2.traj.json") as { messages: { extra?: { timestamp?: number } }[] };
    raw.messages[2].extra!.timestamp = 1e30;
    const t = normalize(raw);
    assert.equal(agents(t!)[0].timestamp, undefined);
  });
});
