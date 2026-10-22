import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const TRAJ_DIR = path.resolve(process.env.TRAJECTORIES_DIR ?? path.join(ROOT, "trajectories"));
const PORT = Number(process.env.PORT ?? 3000);
// Loopback by default: the API has no auth and trajectories can hold prompts and command output.
// Deliberately not plain HOST, which shells and CI images often set to the machine's hostname.
const HOST = process.env.TRAJECTORY_VIEWER_HOST || "127.0.0.1";
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

/** Turn a user-supplied name into a safe `*.json` / `*.traj` file name inside TRAJ_DIR, or null. */
function safeName(raw: string): string | null {
  let name = path.basename(raw.trim()).replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "");
  if (!name) return null;
  if (!/\.(json|traj)$/i.test(name)) name += ".json";
  return name.length > 200 ? null : name;
}

class TooLargeError extends Error {}

/**
 * Read the request body, up to MAX_UPLOAD_BYTES. An oversized body is still read to the end (and
 * discarded) rather than cutting the socket, so the client actually receives the 413.
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_UPLOAD_BYTES) chunks.push(c);
      else chunks.length = 0;
    });
    req.on("end", () => (size > MAX_UPLOAD_BYTES ? reject(new TooLargeError()) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

async function listTrajectories(): Promise<{ name: string; size: number; mtime: number }[]> {
  const entries = await fs.readdir(TRAJ_DIR, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && /\.(json|traj)$/i.test(e.name));
  const out = await Promise.all(
    files.map(async (e) => {
      const st = await fs.stat(path.join(TRAJ_DIR, e.name));
      return { name: e.name, size: st.size, mtime: st.mtimeMs };
    }),
  );
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Write `body` under `name`, or `name-1`, `name-2`, … The exclusive-create flag makes concurrent uploads safe. */
async function writeUnique(name: string, body: Buffer): Promise<string> {
  const ext = path.extname(name);
  const base = name.slice(0, -ext.length);
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? name : `${base}-${i}${ext}`;
    try {
      await fs.writeFile(path.join(TRAJ_DIR, candidate), body, { flag: "wx" });
      return candidate;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
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
      const tooLarge = { error: `file too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` };
      if (Number(req.headers["content-length"]) > MAX_UPLOAD_BYTES) {
        sendJson(res, 413, tooLarge);
        req.resume(); // discard the body instead of resetting the connection
        return;
      }
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch (e) {
        if (e instanceof TooLargeError) return sendJson(res, 413, tooLarge);
        throw e;
      }
      try {
        JSON.parse(body.toString("utf8"));
      } catch {
        return sendJson(res, 400, { error: "file is not valid JSON" });
      }
      return sendJson(res, 201, { name: await writeUnique(name, body) });
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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else if (req.method === "GET") await serveStatic(res, url.pathname);
    else send(res, 405, "method not allowed", "text/plain");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  const where = `${HOST}:${PORT}`;
  const hint: Record<string, string> = {
    EADDRINUSE: `port ${PORT} is already in use; set PORT to another port`,
    EACCES: `not allowed to listen on ${where}; use a port above 1024`,
    ENOTFOUND: `TRAJECTORY_VIEWER_HOST="${HOST}" does not resolve; use an IP address such as 127.0.0.1 or 0.0.0.0`,
    EAI_AGAIN: `TRAJECTORY_VIEWER_HOST="${HOST}" could not be resolved; use an IP address such as 127.0.0.1 or 0.0.0.0`,
    EADDRNOTAVAIL: `${HOST} is not an address of this machine; use 127.0.0.1, 0.0.0.0 or one of its IPs`,
  };
  console.error(`Could not start the trajectory viewer on ${where}: ${hint[err.code ?? ""] ?? err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : PORT;
  console.log(`Trajectory viewer on http://${HOST}:${port} (storing in ${TRAJ_DIR})`);
});
