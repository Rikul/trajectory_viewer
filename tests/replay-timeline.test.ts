import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { normalize } from "../src/client/formats.ts";
import {
  buildTimeline,
  durationFor,
  neighbourStepStart,
  revealed,
  startedCount,
  stepAt,
  type ReplayStepInput,
} from "../src/client/replay-timeline.ts";
import type { Step } from "../src/client/types.ts";

const steps = (...s: Step[]): ReplayStepInput[] => s.map((step) => ({ step }));

describe("buildTimeline", () => {
  const tl = buildTimeline([
    { step: { source: "system", message: "sys" } },
    { step: { source: "user", message: "Fix the bug" } },
    {
      step: {
        source: "agent",
        reasoning_content: "think",
        message: "Running tests",
        tool_calls: [{ function_name: "bash", arguments: { command: "pytest" } }],
        observation: { results: [{ content: "1 failed" }] },
      },
      tone: "error",
    },
    { step: { source: "agent", message: "Done." } },
  ]);

  it("orders segments by step and kind", () => {
    assert.deepEqual(
      tl.segments.map((s) => [s.step, s.kind, s.text]),
      [
        [0, "system", "sys"],
        [1, "user", "Fix the bug"],
        [2, "reasoning", "think"],
        [2, "message", "Running tests"],
        [2, "call", "pytest"],
        [2, "output", "1 failed"],
        [3, "message", "Done."],
      ],
    );
    assert.equal(tl.segments[4].label, "bash");
    assert.equal(tl.segments[5].tone, "error");
  });

  it("lays segments out back to back without overlap", () => {
    for (let i = 1; i < tl.segments.length; i++) {
      const prev = tl.segments[i - 1];
      assert.ok(tl.segments[i].start >= prev.start + prev.duration, `segment ${i} overlaps`);
    }
    const last = tl.segments.at(-1)!;
    assert.equal(tl.total, last.start + last.duration);
  });

  it("records a span per step", () => {
    assert.deepEqual(tl.steps.map((s) => s.step), [0, 1, 2, 3]);
    assert.equal(tl.steps[2].start, tl.segments[2].start);
    assert.equal(tl.steps[2].tone, "error");
    assert.equal(tl.steps[3].end, tl.total);
  });

  it("is empty for no steps", () => {
    assert.deepEqual(buildTimeline([]), { segments: [], steps: [], total: 0 });
  });
});

describe("timing", () => {
  it("scales with text length within each kind's bounds", () => {
    assert.ok(durationFor("message", "x".repeat(50)) < durationFor("message", "x".repeat(200)));
    assert.equal(durationFor("message", ""), 400); // minimum
    assert.equal(durationFor("message", "x".repeat(100_000)), 5000); // maximum
    assert.equal(durationFor("output", "x".repeat(100_000)), 1500);
  });

  it("uses compressed real gaps between timestamped steps, capped", () => {
    const at = (iso: string): Step => ({ source: "agent", message: "x", timestamp: iso });
    const tl = buildTimeline(
      steps(at("2026-01-01T00:00:00Z"), at("2026-01-01T00:00:20Z"), at("2026-01-01T01:00:00Z"), at("2026-01-01T01:00:01Z")),
    );
    const gaps = tl.steps.slice(1).map((s, i) => s.start - tl.steps[i].end);
    assert.deepEqual(gaps, [1000, 2500, 450]); // 20 s × 0.05, capped hour, floor for 1 s
    assert.deepEqual(tl.steps.map((s) => s.realOffset), [0, 20_000, 3_600_000, 3_601_000]);
  });

  it("uses a fixed beat when there are no timestamps", () => {
    const tl = buildTimeline(steps({ source: "agent", message: "a" }, { source: "agent", message: "b" }));
    assert.equal(tl.steps[1].start - tl.steps[0].end, 450);
    assert.equal(tl.steps[0].realOffset, undefined);
  });
});

describe("playback helpers", () => {
  const tl = buildTimeline(steps({ source: "user", message: "hello world" }, { source: "agent", message: "a reply" }));
  const [a, b] = tl.segments;

  it("reveals text proportionally to elapsed time", () => {
    assert.equal(revealed(a, a.start - 1), 0);
    assert.equal(revealed(a, a.start + a.duration / 2), Math.floor(a.text.length / 2));
    assert.equal(revealed(a, a.start + a.duration), a.text.length);
  });

  it("counts started segments and finds the current step", () => {
    assert.equal(startedCount(tl, -1), 0);
    assert.equal(startedCount(tl, 0), 1);
    assert.equal(startedCount(tl, b.start - 1), 1);
    assert.equal(startedCount(tl, b.start), 2);
    assert.equal(stepAt(tl, b.start - 1), 0);
    assert.equal(stepAt(tl, tl.total), 1);
  });

  it("jumps to neighbouring steps like a media player", () => {
    assert.equal(neighbourStepStart(tl, 0, 1), b.start);
    assert.equal(neighbourStepStart(tl, b.start, 1), tl.total); // past the last step: the end
    assert.equal(neighbourStepStart(tl, b.start + 100, -1), 0); // just started: previous step
    assert.equal(neighbourStepStart(tl, b.start + 1000, -1), b.start); // well into it: restart it
  });
});

describe("every fixture", () => {
  const dir = new URL("./fixtures/", import.meta.url);
  for (const file of readdirSync(dir)) {
    it(`builds a non-empty timeline for ${file}`, () => {
      const traj = normalize(JSON.parse(readFileSync(new URL(file, dir), "utf8")))!;
      const tl = buildTimeline((traj.steps ?? []).map((step) => ({ step })));
      assert.ok(tl.segments.length > 0 && tl.total > 0);
      assert.ok(tl.segments.every((s) => s.text.length > 0 && s.duration > 0));
    });
  }
});
