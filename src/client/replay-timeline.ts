// Turns a trajectory into a timed script for the replay player. Pure (no DOM), so it's unit-tested in Node.

import { callText, toText } from "./text.ts";
import type { Step } from "./types.ts";

/** "note" is a placeholder for a step with nothing to show, so its turn (and badges) still appear. */
export type SegmentKind = "system" | "user" | "reasoning" | "message" | "call" | "output" | "note";
export type Tone = "error" | "warn" | "done" | undefined;

/** One piece of the replay that is revealed over [start, start + duration) in replay milliseconds. */
export interface Segment {
  step: number; // index into the steps array
  kind: SegmentKind;
  label?: string; // tool name for calls
  text: string;
  start: number;
  duration: number;
  tone?: Tone; // outputs of a failed / warned step
}

export interface StepSpan {
  step: number;
  start: number;
  end: number;
  tone: Tone;
  /** Milliseconds since the first timestamped step, when the trajectory has real timestamps. */
  realOffset?: number;
}

export interface Timeline {
  segments: Segment[];
  steps: StepSpan[];
  total: number;
}

export interface ReplayStepInput {
  step: Step;
  tone?: Tone;
}

/** Reveal speed per kind: characters per second, clamped to [min, max] milliseconds per segment. */
const SPEED: Record<SegmentKind, { cps: number; min: number; max: number }> = {
  system: { cps: 2000, min: 250, max: 800 },
  user: { cps: 400, min: 400, max: 2000 },
  reasoning: { cps: 160, min: 400, max: 4000 },
  message: { cps: 90, min: 400, max: 5000 },
  call: { cps: 45, min: 350, max: 2500 },
  output: { cps: 900, min: 250, max: 1500 },
  note: { cps: 2000, min: 300, max: 300 },
};
const SEGMENT_GAP = 220; // pause between parts of one step
const STEP_GAP = 450; // default pause between steps
const MAX_STEP_GAP = 2500; // cap for gaps derived from real timestamps
const REAL_GAP_SCALE = 0.05; // real time → replay time for the pause between steps (20× faster)

export function durationFor(kind: SegmentKind, text: string): number {
  const { cps, min, max } = SPEED[kind];
  return Math.round(Math.min(max, Math.max(min, (text.length / cps) * 1000)));
}

function timeOf(s: Step): number | undefined {
  if (!s.timestamp) return undefined;
  const ms = Date.parse(s.timestamp);
  return Number.isFinite(ms) ? ms : undefined;
}

export function buildTimeline(input: ReplayStepInput[]): Timeline {
  const segments: Segment[] = [];
  const steps: StepSpan[] = [];
  const firstTime = input.map((x) => timeOf(x.step)).find((t) => t != null);
  let t = 0;
  let prevTime: number | undefined;

  input.forEach(({ step, tone }, i) => {
    const time = timeOf(step);
    if (i > 0) {
      // Pause before the step: compressed real gap when this step and the one right before it both have
      // timestamps, else a fixed beat (a gap across an untimed step would cover more than one step).
      const real = time != null && prevTime != null ? time - prevTime : undefined;
      t += real != null && real > 0 ? Math.min(MAX_STEP_GAP, Math.max(STEP_GAP, real * REAL_GAP_SCALE)) : STEP_GAP;
    }
    prevTime = time;

    const start = t;
    const add = (kind: SegmentKind, text: string, extra: Partial<Segment> = {}) => {
      if (!text) return;
      if (segments.length && segments[segments.length - 1].step === i) t += SEGMENT_GAP;
      const duration = durationFor(kind, text);
      segments.push({ step: i, kind, text, start: t, duration, ...extra });
      t += duration;
    };

    const message = toText(step.message);
    if (step.source === "agent") {
      add("reasoning", toText(step.reasoning_content));
      add("message", message);
      for (const c of step.tool_calls ?? []) add("call", callText(c) || "(no arguments)", { label: c.function_name ?? "call" });
      for (const r of step.observation?.results ?? []) add("output", toText(r.content) || "(empty)", { tone });
      if (step.error != null) add("output", toText(step.error), { tone: "error" });
      if (!segments.length || segments[segments.length - 1].step !== i) add("note", "(no message, tool calls or output in this step)");
    } else {
      add(step.source === "user" ? "user" : "system", message || toText(step.extra) || "(empty)");
    }
    steps.push({ step: i, start, end: t, tone, realOffset: time != null && firstTime != null ? time - firstTime : undefined });
  });

  return { segments, steps, total: t };
}

/** How many characters of a segment are visible at replay time t. */
export function revealed(seg: Segment, t: number): number {
  if (t <= seg.start) return 0;
  if (t >= seg.start + seg.duration) return seg.text.length;
  return Math.floor((seg.text.length * (t - seg.start)) / seg.duration);
}

/** Number of segments that have started by time t (segments are sorted by start). */
export function startedCount(tl: Timeline, t: number): number {
  let lo = 0;
  let hi = tl.segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tl.segments[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the step being played at time t (the last step that has started). */
export function stepAt(tl: Timeline, t: number): number {
  let idx = 0;
  for (const s of tl.steps) {
    if (s.start <= t) idx = s.step;
    else break;
  }
  return idx;
}

/** Start time of the step before / after the one playing at t, for "previous / next step" controls. */
export function neighbourStepStart(tl: Timeline, t: number, dir: -1 | 1): number {
  if (!tl.steps.length) return 0;
  const cur = tl.steps.findIndex((s) => s.step === stepAt(tl, t));
  if (dir === 1) return cur + 1 < tl.steps.length ? tl.steps[cur + 1].start : tl.total;
  // Like media players: "previous" restarts the current step unless we're right at its beginning.
  const curStart = tl.steps[cur].start;
  return t - curStart > 600 || cur === 0 ? curStart : tl.steps[cur - 1].start;
}
