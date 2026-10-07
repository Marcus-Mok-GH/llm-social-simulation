/**
 * The station host process: one HTTP server that serves the app *and* runs
 * the match.
 *
 *  - Everything that is not `/__umbra/*` goes through Vite's dev middleware
 *    (HMR included — `hmr.server` is this very server), so the preview behaves
 *    like the plain Vite dev server it replaces.
 *  - `/__umbra/events` is an SSE stream: the server pushes `hello` on attach
 *    and `state` frames at the host's broadcast cadence; the browser's native
 *    `EventSource` retry is what makes closing the tab safe — reopening
 *    reconnects and gets a `hello` with the live match.
 *  - `/__umbra/action` carries player input back as small POSTs (no WebSocket
 *    upgrade to fight the preview proxy about).
 *
 * Run with `pnpm dev` from the repo root (the preview command). The exported
 * `startStation` is what `scripts/validate-host.ts` exercises headlessly.
 */

import { randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { MatchHost, type MatchHostOptions, type Viewer } from "./matchHost";
import type { ActionEnvelope, ClientMsg, ServerMsg } from "./protocol";
import { createFileStore, type HostStore } from "./store";

const hostDir = dirname(fileURLToPath(import.meta.url));
const artifactRoot = resolve(hostDir, "..", "..");

export interface StationOptions {
  port?: number;
  dataDir?: string;
  /** Injected store — the headless test uses a temp directory (or memory). */
  store?: HostStore;
  host?: MatchHostOptions;
}

export interface Station {
  host: MatchHost;
  port: number;
  close: () => Promise<void>;
}

export async function startStation(opts: StationOptions = {}): Promise<Station> {
  // The old dev script `cd`'d into the artifact before starting Vite; Tailwind
  // resolves `tailwind.config.js` and its relative `content` globs from the
  // working directory, so restore that from wherever the host was launched.
  process.chdir(artifactRoot);

  const port = opts.port ?? Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`Invalid PORT value: "${process.env.PORT}"`);
  }
  const dataDir = opts.dataDir ?? process.env.UMBRA_DATA_DIR ?? join(artifactRoot, ".data");

  const store = opts.store ?? createFileStore(dataDir);
  const host = new MatchHost(store, opts.host);

  // -- SSE ------------------------------------------------------------------

  function sse(req: IncomingMessage, res: ServerResponse, params: URLSearchParams): void {
    const session = (params.get("session") ?? "").slice(0, 80);
    if (!session) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("missing session");
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Some proxies buffer event streams unless told explicitly not to.
      "x-accel-buffering": "no",
    });
    res.write(": up\n\n");

    const token = randomUUID();
    const send = (msg: ServerMsg): void => {
      try {
        res.write(`event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`);
      } catch {
        // Socket already gone — the close handler will detach the viewer.
      }
    };

    const viewer: Viewer = { session, token, send };
    send(host.attach(viewer));

    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        // ignore
      }
    }, 15_000);

    req.on("close", () => {
      clearInterval(ping);
      host.detach(session, token);
    });
  }

  // -- actions --------------------------------------------------------------

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8192) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  async function postAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let envelope: ActionEnvelope;
    try {
      envelope = JSON.parse(await readBody(req)) as ActionEnvelope;
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad json");
      return;
    }
    const session = String(envelope?.session ?? "").slice(0, 80);
    const msg = envelope?.msg as ClientMsg | undefined;
    if (!session || !msg || typeof msg !== "object" || typeof msg.type !== "string") {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad action");
      return;
    }
    if (msg.type === "say") msg.text = String(msg.text).slice(0, 400);
    host.handleAction(session, msg);
    res.writeHead(204).end();
  }

  function sendJson(res: ServerResponse, value: unknown): void {
    const body = JSON.stringify(value);
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(body);
  }

  function seatFor(session: string | null): "player" | "spectator" | "claimable" {
    const held = host.seatSession;
    if (held === null) return "claimable";
    return session !== null && held === session ? "player" : "spectator";
  }

  async function handleApi(
    apiPath: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const [route, query] = apiPath.split("?");
    const params = new URLSearchParams(query ?? "");

    if (route === "events" && req.method === "GET") {
      sse(req, res, params);
      return;
    }
    if (route === "action" && req.method === "POST") {
      await postAction(req, res);
      return;
    }
    if (route === "match" && req.method === "GET") {
      sendJson(res, {
        matchId: host.matchId,
        seat: seatFor(params.get("session")),
        state: host.buildState(true),
        history: host.matchHistory,
      });
      return;
    }
    if (route === "matches" && req.method === "GET") {
      sendJson(res, host.matchHistory);
      return;
    }
    if (route === "health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }

  // -- server ---------------------------------------------------------------

  const httpServer = createHttpServer();
  const sockets = new Set<Socket>();
  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const vite: ViteDevServer = await createViteServer({
    configFile: join(artifactRoot, "vite.config.ts"),
    server: {
      middlewareMode: true,
      // HMR rides this server's upgrade handling instead of Vite's own listener.
      hmr: { server: httpServer },
    },
  });

  httpServer.on("request", (req, res) => {
    const url = req.url ?? "/";
    const idx = url.indexOf("__umbra/");
    if (idx >= 0) {
      void handleApi(url.slice(idx + "__umbra/".length), req, res).catch((err) => {
        console.error("[umbra] api error:", err);
        if (!res.headersSent) res.writeHead(500);
        res.end("error");
      });
      return;
    }
    vite.middlewares(req, res);
  });

  let last = Date.now();
  const pumpTimer = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    host.pump(dt, now);
  }, 16);
  const broadcastTimer = setInterval(() => host.maybeBroadcast(), host.broadcastMs);

  const boundPort = await new Promise<number>((resolvePort, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "0.0.0.0", () => {
      const addr = httpServer.address();
      resolvePort(typeof addr === "object" && addr ? addr.port : port);
    });
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(pumpTimer);
    clearInterval(broadcastTimer);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((done) => httpServer.close(() => done()));
    await vite.close().catch(() => undefined);
  };

  return { host, port: boundPort, close };
}

// -- entrypoint -------------------------------------------------------------

const isMain =
  typeof import.meta !== "undefined" && (import.meta as { main?: boolean }).main === true;

if (isMain) {
  const station = await startStation();
  console.log(
    `[umbra] station host on http://0.0.0.0:${station.port} · data ${
      process.env.UMBRA_DATA_DIR ?? join(artifactRoot, ".data")
    }`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[umbra] ${signal} — closing`);
    void station.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
