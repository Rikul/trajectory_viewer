import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { request, Agent } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MB = 1024 * 1024;

let proc: ChildProcess;
let base = "";
let dir = "";
let startupLog = "";

function withoutHost(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { TRAJECTORY_VIEWER_HOST: _unused, ...rest } = env;
  return rest;
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "traj-test-"));
  proc = spawn(process.execPath, [path.join(ROOT, "dist/server.js")], {
    // A stray HOST (often the machine's hostname) must not change where the server binds.
    env: { ...withoutHost(process.env), HOST: "0.0.0.0", PORT: "0", TRAJECTORIES_DIR: dir },
    stdio: ["ignore", "pipe", "inherit"],
  });
  base = await new Promise<string>((resolve, reject) => {
    proc.on("exit", (code) => reject(new Error(`server exited with ${code}`)));
    proc.stdout!.on("data", (d: Buffer) => {
      startupLog += d.toString();
      const m = startupLog.match(/http:\/\/([^:/\s]+):(\d+)/);
      if (m) resolve(`http://127.0.0.1:${m[2]}`);
    });
  });
}, { timeout: 10_000 });

after(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const files = () => readdirSync(dir).sort();
const upload = (name: string, body: string) =>
  fetch(`${base}/api/trajectories?name=${encodeURIComponent(name)}`, { method: "POST", body });

/** Raw POST so the test controls headers and streaming; resolves with the status the client receives. */
function rawPost(name: string, opts: { size: number; declareLength: boolean }): Promise<{ status?: number; error?: string }> {
  return new Promise((resolve) => {
    const req = request(`${base}/api/trajectories?name=${name}`, {
      method: "POST",
      headers: opts.declareLength ? { "Content-Length": String(opts.size) } : {},
    });
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on("error", (e: NodeJS.ErrnoException) => resolve({ error: e.code ?? e.message }));
    const chunk = Buffer.alloc(MB, 0x20);
    let sent = 0;
    const write = () => {
      while (sent < opts.size) {
        const n = Math.min(chunk.length, opts.size - sent);
        sent += n;
        if (!req.write(n === chunk.length ? chunk : chunk.subarray(0, n))) return void req.once("drain", write);
      }
      req.end();
    };
    write();
  });
}

describe("server", () => {
  it("binds the loopback interface by default", () => {
    assert.match(startupLog, /http:\/\/127\.0\.0\.1:\d+/);
  });

  it("uploads, lists, reads and deletes a trajectory", async () => {
    const res = await upload("a.json", '{"steps":[]}');
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { name: "a.json" });

    const list = await (await fetch(`${base}/api/trajectories`)).json();
    assert.deepEqual(list.map((f: { name: string }) => f.name), ["a.json"]);
    assert.equal(await (await fetch(`${base}/api/trajectories/a.json`)).text(), '{"steps":[]}');

    assert.equal((await fetch(`${base}/api/trajectories/a.json`, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(`${base}/api/trajectories/a.json`)).status, 404);
  });

  it("keeps .traj files and adds .json to other names", async () => {
    assert.deepEqual(await (await upload("run.traj", "{}")).json(), { name: "run.traj" });
    assert.deepEqual(await (await upload("notes.txt", "{}")).json(), { name: "notes.txt.json" });
  });

  it("rejects invalid JSON", async () => {
    const res = await upload("bad.json", "{nope");
    assert.equal(res.status, 400);
    assert.ok(!files().includes("bad.json"));
  });

  it("suffixes duplicate names", async () => {
    await upload("dup.json", "1");
    assert.deepEqual(await (await upload("dup.json", "2")).json(), { name: "dup-1.json" });
    assert.equal(readFileSync(path.join(dir, "dup.json"), "utf8"), "1");
  });

  it("keeps every body when the same name is uploaded concurrently", async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 32 });
    const bodies = Array.from({ length: 32 }, (_, i) => `{"n":${i}}`);
    const results = await Promise.all(
      bodies.map(
        (body) =>
          new Promise<{ status?: number; name: string }>((resolve, reject) => {
            const req = request(`${base}/api/trajectories?name=race.json`, { method: "POST", agent }, (res) => {
              let data = "";
              res.on("data", (d) => (data += d));
              res.on("end", () => resolve({ status: res.statusCode, name: JSON.parse(data).name }));
            });
            req.on("error", reject);
            req.end(body);
          }),
      ),
    );
    agent.destroy();
    assert.ok(results.every((r) => r.status === 201));
    const names = new Set(results.map((r) => r.name));
    assert.equal(names.size, 32);
    const saved = [...names].map((n) => readFileSync(path.join(dir, n), "utf8")).sort();
    assert.deepEqual(saved, [...bodies].sort());
  });

  it("answers oversized uploads with 413 (declared Content-Length)", async () => {
    const r = await rawPost("big.json", { size: 101 * MB, declareLength: true });
    assert.deepEqual(r, { status: 413 });
    assert.ok(!files().includes("big.json"));
  });

  it("answers oversized uploads with 413 (chunked, no Content-Length)", async () => {
    const r = await rawPost("big2.json", { size: 101 * MB, declareLength: false });
    assert.deepEqual(r, { status: 413 });
    assert.ok(!files().includes("big2.json"));
  });

  it("keeps uploads inside the trajectories directory", async () => {
    for (const name of ["../escape.json", "../../etc/passwd", "/etc/passwd"]) {
      const res = await upload(name, "{}");
      assert.equal(res.status, 201);
      const saved = (await res.json()).name as string;
      assert.ok(!saved.includes("/") && !saved.startsWith("."), saved);
      assert.ok(files().includes(saved));
    }
  });

  it("does not serve files outside public/", async () => {
    for (const p of ["/..%2f..%2fpackage.json", "/%2e%2e/package.json"]) {
      const res = await fetch(base + p);
      assert.ok([403, 404].includes(res.status), `${p} -> ${res.status}`);
    }
    assert.equal((await fetch(`${base}/`)).status, 200);
  });

  it("exits with a clear message when it cannot listen", async () => {
    const run = spawn(process.execPath, [path.join(ROOT, "dist/server.js")], {
      env: { ...process.env, PORT: "0", TRAJECTORY_VIEWER_HOST: "no-such-host.invalid", TRAJECTORIES_DIR: dir },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    run.stderr!.on("data", (d: Buffer) => (stderr += d));
    const code = await new Promise((resolve) => run.on("exit", resolve));
    assert.equal(code, 1);
    assert.match(stderr, /Could not start the trajectory viewer on no-such-host\.invalid:0: .*(does not resolve|could not be resolved)/);
    assert.doesNotMatch(stderr, /Unhandled 'error' event/);
  });
});
