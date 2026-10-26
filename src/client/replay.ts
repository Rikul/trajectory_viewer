// Replay window: plays a trajectory back as an animated conversation in a modal <dialog>.

import {
  buildTimeline,
  neighbourStepStart,
  revealed,
  startedCount,
  stepAt,
  type ReplayStepInput,
  type Segment,
  type Timeline,
} from "./replay-timeline.ts";

export interface ReplayStep extends ReplayStepInput {
  /** Short role label for the turn header, e.g. "task prompt" or the model name. */
  role: string;
  badges: { text: string; cls: string }[];
}

export interface ReplayOptions {
  title: string;
  steps: ReplayStep[];
  /** Index (into steps) to start from; defaults to the beginning. */
  startStep?: number;
}

const SPEEDS = [0.5, 1, 2, 4, 8];
const SPEED_KEY = "tv.replaySpeed";
const FOLLOW_SLACK = 48; // px from the bottom that still counts as "following" the live edge

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(node.dataset, dataset);
  for (const c of children) if (c != null && c !== false) node.append(c);
  return node;
}

/** m:ss (or h:mm:ss) for a duration in milliseconds. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

function loadSpeed(): number {
  try {
    const v = Number(localStorage.getItem(SPEED_KEY));
    return SPEEDS.includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

class ReplayPlayer {
  readonly #steps: ReplayStep[];
  readonly #tl: Timeline;
  readonly #reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  readonly #ac = new AbortController();

  #t = 0;
  #playing = false;
  #speed = loadSpeed();
  #raf = 0;
  #lastFrame = 0;
  #follow = true;

  // Render state: segments [0, #rendered) are in the DOM; #typing holds those still being revealed.
  #rendered = 0;
  #typing = new Set<number>();
  #segText: HTMLElement[] = [];
  #turns = new Map<number, HTMLElement>();
  #currentTurn: HTMLElement | null = null;

  readonly dialog: HTMLDialogElement;
  readonly #stage: HTMLElement;
  readonly #feed: HTMLOListElement;
  readonly #playBtn: HTMLButtonElement;
  readonly #scrub: HTMLInputElement;
  readonly #track: HTMLElement;
  readonly #time: HTMLElement;
  readonly #status: HTMLElement;
  readonly #jump: HTMLButtonElement;

  constructor(opts: ReplayOptions) {
    this.#steps = opts.steps;
    this.#tl = buildTimeline(opts.steps);

    const btn = (act: string, label: string, text: string, cls = "rp-btn") =>
      h("button", { type: "button", className: cls, title: label, ariaLabel: label, dataset: { act } }, text);

    this.#playBtn = btn("toggle", "Play (Space)", "▶", "rp-btn rp-play");
    this.#scrub = h("input", { type: "range", className: "rp-scrub", min: "0", max: String(this.#tl.total), step: "1", value: "0", ariaLabel: "Replay position" });
    this.#time = h("span", { className: "rp-time" });
    this.#status = h("span", { className: "rp-status", ariaLive: "polite" });
    this.#feed = h("ol", { className: "rp-feed" });
    this.#jump = h("button", { type: "button", className: "rp-jump", hidden: true }, "↓ Follow");
    this.#stage = h("div", { className: "rp-stage" }, this.#feed, this.#jump);

    const marks = h("div", { className: "rp-marks", ariaHidden: "true" });
    for (const s of this.#tl.steps) {
      const left = this.#tl.total ? (s.start / this.#tl.total) * 100 : 0;
      const mark = h("span", { className: `rp-mark${s.tone ? ` t-${s.tone}` : ""}` });
      mark.style.setProperty("--at", `${left}%`);
      marks.append(mark);
    }
    this.#track = h("div", { className: "rp-track" }, marks, this.#scrub);

    const speed = h(
      "select",
      { className: "rp-speed", ariaLabel: "Playback speed", title: "Speed (+ / −)" },
      ...SPEEDS.map((s) => h("option", { value: String(s), selected: s === this.#speed }, `${s}×`)),
    );

    this.dialog = h(
      "dialog",
      { className: "replay", ariaLabel: `Replay: ${opts.title}` },
      h(
        "header",
        { className: "rp-head" },
        h("div", { className: "rp-titles" }, h("h2", {}, opts.title), this.#status),
        h("button", { type: "button", className: "rp-btn rp-close", title: "Close (Esc)", ariaLabel: "Close replay", dataset: { act: "close" } }, "✕"),
      ),
      this.#stage,
      h(
        "footer",
        { className: "rp-controls" },
        h(
          "div",
          { className: "rp-buttons" },
          btn("restart", "Restart (Home)", "⏮"),
          btn("prev", "Previous step (←)", "⏪"),
          this.#playBtn,
          btn("next", "Next step (→)", "⏩"),
        ),
        this.#track,
        this.#time,
        speed,
      ),
    );
    this.dialog.setAttribute("closedby", "any"); // light dismiss where supported; the click handler covers the rest

    this.#wire(speed);
    if (opts.startStep) this.#t = this.#tl.steps.find((s) => s.step === opts.startStep)?.start ?? 0;
  }

  open(): void {
    document.body.append(this.dialog);
    this.dialog.showModal();
    this.#render();
    this.#playBtn.focus();
    this.play();
  }

  play(): void {
    if (this.#playing) return;
    if (this.#t >= this.#tl.total) this.#seek(0);
    this.#playing = true;
    this.#lastFrame = performance.now();
    this.#raf = requestAnimationFrame(this.#tick);
    this.#syncPlayButton();
  }

  pause(): void {
    this.#playing = false;
    cancelAnimationFrame(this.#raf);
    this.#syncPlayButton();
  }

  toggle(): void {
    this.#playing ? this.pause() : this.play();
  }

  #tick = (now: number): void => {
    if (!this.#playing) return;
    const dt = Math.min(250, now - this.#lastFrame); // a backgrounded tab shouldn't jump ahead on return
    this.#lastFrame = now;
    this.#t = Math.min(this.#tl.total, this.#t + dt * this.#speed);
    this.#render();
    if (this.#t >= this.#tl.total) this.pause();
    else this.#raf = requestAnimationFrame(this.#tick);
  };

  #seek(t: number): void {
    this.#t = Math.min(this.#tl.total, Math.max(0, t));
    this.#follow = true;
    this.#render();
  }

  #setSpeed(s: number, select: HTMLSelectElement): void {
    this.#speed = s;
    select.value = String(s);
    try {
      localStorage.setItem(SPEED_KEY, String(s));
    } catch {
      /* storage unavailable */
    }
  }

  #syncPlayButton(): void {
    const ended = !this.#playing && this.#t >= this.#tl.total;
    this.#playBtn.textContent = this.#playing ? "⏸" : ended ? "↻" : "▶";
    const label = this.#playing ? "Pause (Space)" : ended ? "Replay again (Space)" : "Play (Space)";
    this.#playBtn.title = label;
    this.#playBtn.ariaLabel = label;
    this.dialog.classList.toggle("is-playing", this.#playing);
  }

  // ---- Rendering ----

  #render(): void {
    const t = this.#t;
    const n = startedCount(this.#tl, t);
    if (n < this.#rendered) this.#reset(); // seeking backwards: rebuild from scratch
    for (let i = this.#rendered; i < n; i++) this.#mount(i);
    this.#rendered = n;

    for (const i of this.#typing) {
      const seg = this.#tl.segments[i];
      const shown = this.#reduceMotion ? seg.text.length : revealed(seg, t);
      const node = this.#segText[i];
      node.textContent = seg.text.slice(0, shown);
      const done = shown >= seg.text.length;
      node.parentElement!.classList.toggle("typing", !done);
      if (done) this.#typing.delete(i);
    }

    // Header, scrubber and current-turn highlight.
    const stepIdx = stepAt(this.#tl, t);
    const span = this.#tl.steps.find((s) => s.step === stepIdx);
    const real = span?.realOffset != null ? ` · run time +${clock(span.realOffset)}` : "";
    this.#status.textContent = this.#tl.steps.length ? `Step ${stepIdx + 1} of ${this.#steps.length}${real}` : "Nothing to replay";
    this.#time.textContent = `${clock(t)} / ${clock(this.#tl.total)}`;
    this.#scrub.value = String(Math.round(t));
    this.#track.style.setProperty("--p", `${this.#tl.total ? (t / this.#tl.total) * 100 : 0}%`);
    const turn = this.#turns.get(stepIdx) ?? null;
    if (turn !== this.#currentTurn) {
      this.#currentTurn?.classList.remove("current");
      turn?.classList.add("current");
      this.#currentTurn = turn;
    }
    this.#syncPlayButton();

    if (this.#follow) this.#stage.scrollTop = this.#stage.scrollHeight;
  }

  #reset(): void {
    this.#feed.replaceChildren();
    this.#rendered = 0;
    this.#typing.clear();
    this.#segText = [];
    this.#turns.clear();
    this.#currentTurn = null;
  }

  #turnFor(stepIdx: number): HTMLElement {
    let turn = this.#turns.get(stepIdx);
    if (turn) return turn;
    const rs = this.#steps[stepIdx];
    const source = rs.step.source ?? "step";
    turn = h(
      "li",
      { className: "rp-turn", dataset: { source, ...(rs.tone ? { tone: rs.tone } : {}) } },
      h(
        "div",
        { className: "rp-turn-head" },
        h("span", { className: "rp-sid" }, `#${rs.step.step_id ?? stepIdx + 1}`),
        h("span", { className: "rp-role" }, rs.role),
        ...rs.badges.map((b) => h("span", { className: `badge ${b.cls}` }, b.text)),
      ),
    );
    this.#feed.append(turn);
    this.#turns.set(stepIdx, turn);
    return turn;
  }

  #mount(i: number): void {
    const seg: Segment = this.#tl.segments[i];
    const text = h("span", { className: "rp-text" });
    let node: HTMLElement;
    switch (seg.kind) {
      case "call":
        node = h("div", { className: "rp-seg rp-call" }, h("div", { className: "rp-call-name" }, seg.label ?? "call"), h("pre", {}, text));
        break;
      case "output":
        node = h("pre", { className: `rp-seg rp-output${seg.tone ? ` t-${seg.tone}` : ""}` }, text);
        break;
      case "reasoning":
        node = h("div", { className: "rp-seg rp-reasoning" }, h("span", { className: "rp-kicker" }, "thinking"), text);
        break;
      default:
        node = h("div", { className: `rp-seg rp-${seg.kind}` }, text);
    }
    this.#turnFor(seg.step).append(node);
    this.#segText[i] = text;
    this.#typing.add(i);
  }

  // ---- Events ----

  #wire(speed: HTMLSelectElement): void {
    const { signal } = this.#ac;
    const d = this.dialog;

    d.addEventListener(
      "click",
      (e) => {
        if (e.target === d) return d.close(); // backdrop click (browsers without closedby)
        const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
        if (act === "close") d.close();
        else if (act === "toggle") this.toggle();
        else if (act === "restart") this.#seek(0);
        else if (act === "prev") this.#seek(neighbourStepStart(this.#tl, this.#t, -1));
        else if (act === "next") this.#seek(neighbourStepStart(this.#tl, this.#t, 1));
      },
      { signal },
    );

    this.#scrub.addEventListener("input", () => this.#seek(Number(this.#scrub.value)), { signal });
    speed.addEventListener("change", () => this.#setSpeed(Number(speed.value), speed), { signal });

    this.#stage.addEventListener(
      "scroll",
      () => {
        const s = this.#stage;
        this.#follow = s.scrollHeight - s.scrollTop - s.clientHeight < FOLLOW_SLACK;
        this.#jump.hidden = this.#follow;
      },
      { signal, passive: true },
    );
    this.#jump.addEventListener("click", () => {
      this.#follow = true;
      this.#jump.hidden = true;
      this.#stage.scrollTo({ top: this.#stage.scrollHeight, behavior: this.#reduceMotion ? "instant" : "smooth" });
    }, { signal });

    d.addEventListener(
      "keydown",
      (e) => {
        const target = e.target as HTMLElement;
        const inControl = target.matches("button, select, input");
        const step = SPEEDS.indexOf(this.#speed);
        switch (e.key) {
          case " ":
          case "k":
            if (e.key === " " && inControl) return; // let the focused control handle Space itself
            this.toggle();
            break;
          case "ArrowLeft":
          case "ArrowRight":
            if (target === this.#scrub) return; // the slider moves itself
            this.#seek(neighbourStepStart(this.#tl, this.#t, e.key === "ArrowLeft" ? -1 : 1));
            break;
          case "Home":
            this.#seek(0);
            break;
          case "End":
            this.#seek(this.#tl.total);
            break;
          case "+":
          case "=":
            this.#setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, step + 1)], speed);
            break;
          case "-":
            this.#setSpeed(SPEEDS[Math.max(0, step - 1)], speed);
            break;
          default:
            return;
        }
        e.preventDefault();
      },
      { signal },
    );

    d.addEventListener(
      "close",
      () => {
        this.pause();
        this.#ac.abort();
        d.remove();
      },
      { signal },
    );
  }
}

/** Open the replay window for a trajectory. Returns the player's dialog (handy for tests). */
export function openReplay(opts: ReplayOptions): HTMLDialogElement {
  const player = new ReplayPlayer(opts);
  player.open();
  return player.dialog;
}
