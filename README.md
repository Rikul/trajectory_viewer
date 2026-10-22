# Trajectory Viewer

A minimal viewer for ATIF agent trajectories (`trajectory.json`).

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
- `public/` — `index.html`, `styles.css`

Step markers: parse errors and warnings are detected from terminus-style feedback in the observation
("Previous response had parsing errors / warnings"); "task complete" comes from a `mark_task_complete` tool call.
