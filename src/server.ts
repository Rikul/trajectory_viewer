import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const TRAJ_DIR = path.resolve(process.env.TRAJECTORIES_DIR ?? path.join(ROOT, "trajectories"));
const PORT = Number(process.env.PORT ?? 3000);
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json; charset=utf-8"): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  send(res, status, JSON.stringify(data));
}

/** Turn a user-supplied name into a safe `*.json` file name inside TRAJ_DIR, or null. */
function safeName(raw: string): string | null {
  let name = path.basename(raw.trim()).replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "");
  if (!name) return null;
  if (!name.toLowerCase().endsWith(".json")) name += ".json";
  return name.length > 200 ? null : name;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(new Error("too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function listTrajectories(): Promise<{ name: string; size: number; mtime: number }[]> {
  const entries = await fs.readdir(TRAJ_DIR, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json"));
  const out = await Promise.all(
    files.map(async (e) => {
      const st = await fs.stat(path.join(TRAJ_DIR, e.name));
      return { name: e.name, size: st.size, mtime: st.mtimeMs };
    }),
  );
  return out.sort((a, b) => b.mtime - a.mtime);
}

async function uniqueName(name: string): Promise<string> {
  const ext = path.extname(name);
  const base = name.slice(0, -ext.length);
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? name : `${base}-${i}${ext}`;
    try {
      await fs.access(path.join(TRAJ_DIR, candidate));
    } catch {
      return candidate;
    }
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "trajectories", name?]
  if (parts[1] !== "trajectories" || parts.length > 3) return sendJson(res, 404, { error: "not found" });

  if (parts.length === 2) {
    if (req.method === "GET") return sendJson(res, 200, await listTrajectories());
    if (req.method === "POST") {
      const name = safeName(url.searchParams.get("name") ?? "trajectory.json");
      if (!name) return sendJson(res, 400, { error: "invalid file name" });
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        return sendJson(res, 413, { error: "file too large" });
      }
      try {
        JSON.parse(body.toString("utf8"));
      } catch {
        return sendJson(res, 400, { error: "file is not valid JSON" });
      }
      const finalName = await uniqueName(name);
      await fs.writeFile(path.join(TRAJ_DIR, finalName), body);
      return sendJson(res, 201, { name: finalName });
    }
    return sendJson(res, 405, { error: "method not allowed" });
  }

  const name = safeName(decodeURIComponent(parts[2]));
  if (!name) return sendJson(res, 400, { error: "invalid file name" });
  const file = path.join(TRAJ_DIR, name);
  try {
    if (req.method === "GET") return send(res, 200, await fs.readFile(file));
    if (req.method === "DELETE") {
      await fs.unlink(file);
      return sendJson(res, 200, { ok: true });
    }
  } catch {
    return sendJson(res, 404, { error: "trajectory not found" });
  }
  return sendJson(res, 405, { error: "method not allowed" });
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, "forbidden", "text/plain");
  try {
    const data = await fs.readFile(file);
    send(res, 200, data, MIME[path.extname(file)] ?? "application/octet-stream");
  } catch {
    send(res, 404, "not found", "text/plain");
  }
}

await fs.mkdir(TRAJ_DIR, { recursive: true });

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else if (req.method === "GET") await serveStatic(res, url.pathname);
    else send(res, 405, "method not allowed", "text/plain");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
  }
}).listen(PORT, () => {
  console.log(`Trajectory viewer on http://localhost:${PORT} (storing in ${TRAJ_DIR})`);
});
