# Trajectory Viewer

A minimal viewer for agent trajectories. Supported formats:

- **ATIF** (`schema_version`, `agent`, `steps[]`), e.g. Harbor / terminus-2 `trajectory.json`
- **Chat logs** (`messages[]` in OpenAI chat format + `llm_calls[]` with per-call model/usage, optional `system_prompt`, `usage_total`). Each assistant message becomes a step, paired in order with `llm_calls` for tokens/cost; tool results become its observation.

- Upload `.json` files from the collapsible sidebar (click or drag-and-drop). They're stored on the server in `trajectories/`.
- Click a trajectory to view it: header with model / harness / token totals, plus one collapsible row per step.
- Filter by **All / Warnings + errors / Errors only / Warnings only**, search across messages, commands and outputs, and **Expand all / Collapse all**.

## Run

```bash
npm install
npm run build   # compiles src/server.ts -> dist/, src/client/app.ts -> public/app.js
npm start       # http://localhost:3000
```

Environment variables: `PORT` (default `3000`), `TRAJECTORIES_DIR` (default `./trajectories`).

## Layout

- `src/server.ts` — Node `http` server (no framework): static files + JSON API
  - `GET /api/trajectories` — list
  - `POST /api/trajectories?name=<file>.json` — upload (raw JSON body; name collisions get a `-N` suffix)
  - `GET|DELETE /api/trajectories/<file>.json`
- `src/client/app.ts` — client-side TypeScript, compiled to plain browser JS
- `src/client/formats.ts` — converts supported formats into the viewer's ATIF-shaped model (`src/client/types.ts`)
- `public/` — `index.html`, `styles.css`

Step markers:
- ATIF: parse errors / warnings come from terminus-style feedback in the observation ("Previous response had
  parsing errors / warnings"); "task complete" comes from a `mark_task_complete` tool call.
- Chat logs: "tool error" when a tool result starts with `Error executing…`, `Error:` or a traceback; the last
  assistant reply with no tool calls is marked "final answer".
