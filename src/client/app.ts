import { normalize } from "./formats.js";
import type { Step, ToolCall, Trajectory } from "./types.js";

type Kind = "user" | "done" | "error" | "warn" | "plain";
type Filter = "all" | "issues" | "errors" | "warnings";

interface ViewStep {
  step: Step;
  index: number;
  kind: Kind;
  isError: boolean;
  isWarning: boolean;
  isComplete: boolean;
  labels: { error: string; warning: string; complete: string };
  preview: string;
  haystack: string; // lowercased text used for search
}

// ---- DOM helpers ----

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  for (const c of children) if (c != null) node.append(c);
  return node;
}

/** Text node(s) with every match of the current search query wrapped in <mark>. */
function highlighted(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const q = state.query;
  if (!q) {
    frag.append(text);
    return frag;
  }
  const lower = text.toLowerCase();
  let pos = 0;
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, pos)) {
    frag.append(text.slice(pos, i), el("mark", undefined, text.slice(i, i + q.length)));
    pos = i + q.length;
  }
  frag.append(text.slice(pos));
  return frag;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** Flatten strings, content-part arrays ({type:"text", text}) or arbitrary JSON into display text. */
function toText(v: unknown): string {
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

// ---- Trajectory analysis ----

// terminus-style feedback the harness sends back after a malformed response
const ERROR_RE = /previous response had parsing errors/i;
const WARNING_RE = /previous response had warnings/i;

function isCompleteCall(c: ToolCall): boolean {
  if (/task_complete|mark_complete|^(submit|finish)$/i.test(c.function_name ?? "")) return true;
  const a = c.arguments as Record<string, unknown> | null;
  return !!a && typeof a === "object" && (a.task_complete === true || a.is_task_complete === true);
}

function observationText(s: Step): string {
  return (s.observation?.results ?? []).map((r) => toText(r.content)).join("\n");
}

function analyze(traj: Trajectory): ViewStep[] {
  return (traj.steps ?? []).map((step, index) => {
    const obs = observationText(step);
    const isAgent = step.source === "agent";
    const f = step.flags;
    const isError = f ? !!f.error : step.error != null || (isAgent && ERROR_RE.test(obs));
    const isWarning = !isError && (f ? !!f.warning : isAgent && WARNING_RE.test(obs));
    const isComplete = f ? !!f.complete : (step.tool_calls ?? []).some(isCompleteCall);
    const labels = {
      error: f?.error ?? (step.error != null ? "error" : "parse error"),
      warning: f?.warning ?? "warning",
      complete: f?.complete ?? "task complete",
    };
    const message = toText(step.message);
    const kind: Kind =
      step.source === "user" ? "user" : isError ? "error" : isWarning ? "warn" : isComplete ? "done" : "plain";
    const calls = (step.tool_calls ?? []).map((c) => `${c.function_name ?? ""} ${toText(c.arguments)}`).join("\n");
    return {
      step,
      index,
      kind,
      isError,
      isWarning,
      isComplete,
      labels,
      preview: message.replace(/\s+/g, " ").trim() || (calls ? calls.replace(/\s+/g, " ") : "(no message)"),
      haystack: [message, toText(step.reasoning_content), calls, obs].join("\n").toLowerCase(),
    };
  });
}

function modelOf(traj: Trajectory): string {
  return traj.agent?.model_name ?? traj.steps?.find((s) => s.model_name)?.model_name ?? "unknown model";
}

function taskOf(traj: Trajectory, fileName: string): string {
  const x = { ...traj.agent?.extra, ...traj.extra } as Record<string, unknown>;
  const t = traj.task_name ?? x.task_name ?? x.task_id ?? x.task;
  return typeof t === "string" && t ? t : fileName.replace(/\.json$/i, "");
}

/** Sum of a per-step token count, or undefined when no step reports it. */
function sumMetric(traj: Trajectory, key: "prompt_tokens" | "completion_tokens" | "cached_tokens"): number | undefined {
  const vals = (traj.steps ?? []).map((s) => s.metrics?.[key]).filter((v): v is number => typeof v === "number");
  return vals.length ? vals.reduce((a, b) => a + b, 0) : undefined;
}

const fmtOpt = (n: number | undefined) => (n == null ? undefined : fmt(n));

// ---- State ----

const state = {
  files: [] as { name: string; size: number; mtime: number }[],
  current: null as string | null,
  traj: null as Trajectory | null,
  steps: [] as ViewStep[],
  open: new Set<number>(),
  filter: "all" as Filter,
  query: "",
};

// ---- Sidebar ----

const sidebar = $("sidebar");
const SIDEBAR_KEY = "tv.sidebarCollapsed";

function setSidebar(collapsed: boolean): void {
  sidebar.classList.toggle("collapsed", collapsed);
  const btn = $("sb-toggle");
  btn.innerHTML = collapsed ? "&raquo;" : "&laquo;";
  btn.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

$("sb-toggle").addEventListener("click", () => setSidebar(!sidebar.classList.contains("collapsed")));

async function refreshList(): Promise<void> {
  const res = await fetch("/api/trajectories");
  state.files = res.ok ? await res.json() : [];
  renderList();
}

function renderList(): void {
  const list = $("traj-list");
  list.replaceChildren();
  if (!state.files.length) {
    list.append(el("li", "muted small", "No trajectories yet."));
    return;
  }
  for (const f of state.files) {
    const del = el("button", "del", "✕");
    del.title = "Delete";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      void deleteTrajectory(f.name);
    });
    const name = el("span", "name", f.name);
    name.title = `${f.name}\n${(f.size / 1024).toFixed(1)} KB · ${new Date(f.mtime).toLocaleString()}`;
    const li = el("li", f.name === state.current ? "active" : "", name, del);
    li.addEventListener("click", () => (location.hash = encodeURIComponent(f.name)));
    list.append(li);
  }
}

async function deleteTrajectory(name: string): Promise<void> {
  if (!confirm(`Delete ${name}?`)) return;
  await fetch(`/api/trajectories/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (state.current === name) location.hash = "";
  await refreshList();
}

async function upload(files: FileList | File[]): Promise<void> {
  const status = $("upload-status");
  let last: string | null = null;
  const failures: string[] = [];
  for (const file of Array.from(files)) {
    status.textContent = `Uploading ${file.name}…`;
    const res = await fetch(`/api/trajectories?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) last = data.name;
    else failures.push(`${file.name}: ${data.error ?? res.statusText}`);
  }
  status.textContent = failures.length ? failures.join("; ") : last ? "Uploaded." : "";
  await refreshList();
  if (last) location.hash = encodeURIComponent(last);
}

const input = $<HTMLInputElement>("file-input");
input.addEventListener("change", () => {
  if (input.files?.length) void upload(input.files);
  input.value = "";
});
const dz = $("dropzone");
dz.addEventListener("dragover", (e) => {
  e.preventDefault();
  dz.classList.add("over");
});
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", (e) => {
  e.preventDefault();
  dz.classList.remove("over");
  if (e.dataTransfer?.files.length) void upload(e.dataTransfer.files);
});

// ---- Loading ----

async function loadFromHash(): Promise<void> {
  const name = decodeURIComponent(location.hash.slice(1));
  state.current = name || null;
  renderList();
  if (!name) {
    $("viewer").hidden = true;
    $("empty").hidden = false;
    $("empty").textContent = "Select a trajectory from the sidebar or upload one.";
    return;
  }
  const res = await fetch(`/api/trajectories/${encodeURIComponent(name)}`);
  if (!res.ok) return showError(`Could not load ${name}.`);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return showError(`${name} is not valid JSON.`);
  }
  const traj = normalize(raw);
  if (!traj) return showError(`${name} isn't a recognised trajectory (expected ATIF "steps" or a chat log with "messages").`);
  state.traj = traj;
  state.steps = analyze(traj);
  state.open.clear();
  renderTrajectory();
}

function showError(msg: string): void {
  $("viewer").hidden = true;
  $("empty").hidden = false;
  $("empty").textContent = msg;
}

// ---- Rendering ----

function renderTrajectory(): void {
  const traj = state.traj!;
  const name = state.current!;
  const model = modelOf(traj);
  const task = taskOf(traj, name);
  $("empty").hidden = true;
  $("viewer").hidden = false;
  $("title").textContent = task;
  document.title = `${task} · Trajectory Viewer`;

  const fm = traj.final_metrics ?? {};
  const agent = traj.agent ?? {};
  const parser = agent.extra?.parser ?? agent.extra?.parser_name;
  const meta: [string, string | undefined][] = [
    ["Model", model],
    ["Harness", agent.name ? `${agent.name}${agent.version ? ` v${agent.version}` : ""}` : undefined],
    ["Parser", typeof parser === "string" ? parser : undefined],
    ["Schema", traj.schema_version],
    ["Steps", fmt(fm.total_steps ?? state.steps.length)],
    ["Prompt tok", fmtOpt(fm.total_prompt_tokens ?? sumMetric(traj, "prompt_tokens"))],
    ["Cached tok", fmtOpt(fm.total_cached_tokens ?? sumMetric(traj, "cached_tokens"))],
    ["Completion tok", fmtOpt(fm.total_completion_tokens ?? sumMetric(traj, "completion_tokens"))],
    ["Cost", fm.total_cost_usd != null ? `$${fm.total_cost_usd.toFixed(4)}` : undefined],
    ...(traj.meta ?? []),
    ["Session", traj.session_id],
  ];
  $("meta").replaceChildren(
    ...meta.filter(([, v]) => v).map(([k, v]) => el("span", undefined, `${k}: `, el("b", undefined, v!))),
  );
  $("footer").textContent = `task ${task} · ${model}`;
  renderSteps();
}

function matchesFilter(v: ViewStep): boolean {
  switch (state.filter) {
    case "issues":
      return v.isError || v.isWarning;
    case "errors":
      return v.isError;
    case "warnings":
      return v.isWarning;
    default:
      return true;
  }
}

function renderSteps(): void {
  const visible = state.steps.filter((v) => matchesFilter(v) && (!state.query || v.haystack.includes(state.query)));
  const errors = state.steps.filter((v) => v.isError).length;
  const warnings = state.steps.filter((v) => v.isWarning).length;
  $("counts").textContent =
    `${visible.length} / ${state.steps.length} steps shown · ${errors} error${errors === 1 ? "" : "s"} · ` +
    `${warnings} warning${warnings === 1 ? "" : "s"}`;

  const container = $("steps");
  container.replaceChildren(...visible.map(renderStep));
  if (!visible.length) container.append(el("div", "empty", "No steps match."));
}

function renderStep(v: ViewStep): HTMLElement {
  const s = v.step;
  const box = el("div", `step k-${v.kind}`);
  const badges: HTMLElement[] = [];
  if (s.source === "user")
    badges.push(el("span", "badge user", state.steps.find((x) => x.step.source === "user") === v ? "task prompt" : "user"));
  else if (s.source === "agent") badges.push(el("span", "badge", (s.model_name ?? state.traj?.agent?.model_name ?? "agent").split("/").pop()!));
  else badges.push(el("span", "badge", s.source === "system" ? "system prompt" : (s.source ?? "step")));
  if (v.isError) badges.push(el("span", "badge error", v.labels.error));
  if (v.isWarning) badges.push(el("span", "badge warn", v.labels.warning));
  if (v.isComplete) badges.push(el("span", "badge done", v.labels.complete));

  const stats: string[] = [];
  const nCalls = s.tool_calls?.length ?? 0;
  if (nCalls) stats.push(`${nCalls} call${nCalls === 1 ? "" : "s"}`);
  if (s.metrics?.prompt_tokens != null || s.metrics?.completion_tokens != null)
    stats.push(`${fmt(s.metrics.prompt_tokens ?? 0)}→${fmt(s.metrics.completion_tokens ?? 0)} tok`);

  const head = el(
    "div",
    "step-head",
    el("span", "caret", "▶"),
    el("span", "sid", `#${s.step_id ?? v.index + 1}`),
    ...badges,
    el("span", "preview", highlighted(v.preview.slice(0, 400))),
    stats.length ? el("span", "stats", stats.join(" · ")) : null,
  );
  const body = el("div", "step-body");
  box.append(head, body);

  const setOpen = (open: boolean) => {
    box.classList.toggle("open", open);
    if (open && !body.childElementCount) body.append(...renderBody(v));
  };
  head.addEventListener("click", () => {
    const open = !state.open.has(v.index);
    if (open) state.open.add(v.index);
    else state.open.delete(v.index);
    setOpen(open);
  });
  setOpen(state.open.has(v.index));
  return box;
}

function section(title: string, ...content: Node[]): HTMLElement {
  return el("div", "sec", el("div", "sec-title", title), ...content);
}

function pre(text: string, cls = ""): HTMLElement {
  return el("pre", cls, highlighted(text));
}

function renderBody(v: ViewStep): HTMLElement[] {
  const s = v.step;
  const out: HTMLElement[] = [];
  const message = toText(s.message);
  if (message) out.push(section(s.source === "user" ? "Prompt" : "Message", pre(message, "text")));
  const reasoning = toText(s.reasoning_content);
  if (reasoning) out.push(section("Reasoning", pre(reasoning, "text")));

  if (s.tool_calls?.length) {
    const calls = s.tool_calls.map((c) => {
      const args = c.arguments as Record<string, unknown> | undefined;
      const title = el("div", "call-name", c.function_name ?? "call");
      if (args && typeof args === "object" && typeof args.duration === "number")
        title.append(el("span", "muted", `  (wait ${args.duration}s)`));
      let content: string;
      if (args && typeof args === "object" && typeof args.keystrokes === "string") content = args.keystrokes;
      else if (args && typeof args === "object" && typeof args.command === "string") content = args.command;
      else content = args == null || (typeof args === "object" && !Object.keys(args).length) ? "" : toText(args);
      return el("div", "call", title, content ? pre(content) : null);
    });
    out.push(section("Tool calls", ...calls));
  }

  const results = s.observation?.results ?? [];
  if (results.length) {
    const cls = v.isError ? "err" : v.isWarning ? "warn" : "";
    out.push(section("Observation", ...results.map((r) => pre(toText(r.content) || "(empty)", cls))));
  }
  if (s.error != null) out.push(section("Error", pre(toText(s.error), "err")));

  const m = s.metrics;
  const metaBits = [
    s.timestamp && `time ${s.timestamp}`,
    s.model_name && `model ${s.model_name}`,
    m?.prompt_tokens != null && `prompt ${fmt(m.prompt_tokens)}`,
    m?.cached_tokens != null && `cached ${fmt(m.cached_tokens)}`,
    m?.completion_tokens != null && `completion ${fmt(m.completion_tokens)}`,
    m?.cost_usd != null && `cost $${m.cost_usd.toFixed(4)}`,
    ...(s.details ?? []),
  ].filter(Boolean);
  if (metaBits.length) out.push(el("div", "sec muted small", metaBits.join(" · ")));
  if (s.extra && Object.keys(s.extra).length) out.push(section("Extra", pre(JSON.stringify(s.extra, null, 2))));
  return out;
}

// ---- Toolbar ----

$("filters").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-filter]");
  if (!btn) return;
  state.filter = btn.dataset.filter as Filter;
  for (const b of $("filters").querySelectorAll("button")) b.classList.toggle("active", b === btn);
  renderSteps();
});

let searchTimer = 0;
$<HTMLInputElement>("search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    state.query = (e.target as HTMLInputElement).value.trim().toLowerCase();
    renderSteps();
  }, 150);
});

$("expand-all").addEventListener("click", () => {
  state.steps.forEach((v) => state.open.add(v.index));
  renderSteps();
});
$("collapse-all").addEventListener("click", () => {
  state.open.clear();
  renderSteps();
});

// ---- Boot ----

try {
  setSidebar(localStorage.getItem(SIDEBAR_KEY) === "1");
} catch {
  setSidebar(false);
}
window.addEventListener("hashchange", () => void loadFromHash());
void refreshList().then(loadFromHash);
