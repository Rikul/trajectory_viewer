import type { Step, ToolCall } from "./types.ts";

/** Flatten strings, content-part arrays ({type:"text", text}) or arbitrary JSON into display text. */
export function toText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(toText).filter(Boolean).join("\n");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (o.type === "image" || o.type === "image_url") return "[image]";
    return JSON.stringify(v, null, 2);
  }
  return String(v);
}

/** The text worth showing for a tool call: keystrokes / command when present, else the JSON arguments. */
export function callText(c: ToolCall): string {
  const args = c.arguments as Record<string, unknown> | undefined;
  if (args && typeof args === "object") {
    if (typeof args.keystrokes === "string") return args.keystrokes;
    if (typeof args.command === "string") return args.command;
    if (!Object.keys(args).length) return "";
  }
  return args == null ? "" : toText(args);
}

export function observationText(s: Step): string {
  return (s.observation?.results ?? []).map((r) => toText(r.content)).join("\n");
}
