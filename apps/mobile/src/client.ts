// WebSocket client for the landline protocol (docs/PROTOCOL.md).
//
// Connections are single-purpose, matching the protocol's one-way doors:
// a control connection for request/response, a fresh connection per attach,
// a fresh connection per watch.

import {
  Frame,
  PROTOCOL_VERSION,
  Request,
  Response,
  SessionEvent,
  EnvironmentInfo,
  SpawnRequest,
  TemplateInfo,
} from "./proto";
import { stats } from "./stats";

export interface ConnectionConfig {
  /** host:port of the daemon's --ws listener */
  host: string;
  token: string;
}

export function wsUrl(cfg: ConnectionConfig): string {
  return `ws://${cfg.host}/ws?token=${encodeURIComponent(cfg.token)}`;
}

function openSocket(cfg: ConnectionConfig): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(cfg));
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("connection timed out"));
    }, 8000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("connection failed (host/token?)"));
    };
  });
}

/** Request/response over one connection. Control responses arrive in
 * request order, so a resolver queue is sufficient. */
export class ControlConn {
  private queue: Array<(r: Response) => void> = [];

  private constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => {
      const resp = JSON.parse(String(ev.data)) as Response;
      this.queue.shift()?.(resp);
    };
    ws.onclose = () => {
      const err: Response = { type: "error", message: "connection closed" };
      this.queue.splice(0).forEach((fn) => fn(err));
    };
  }

  static async open(cfg: ConnectionConfig): Promise<ControlConn> {
    return new ControlConn(await openSocket(cfg));
  }

  request(req: Request): Promise<Response> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.ws.send(JSON.stringify(req));
    });
  }

  async hello(): Promise<{ version: number; features: string[] }> {
    const r = await this.request({ type: "hello", version: PROTOCOL_VERSION });
    if (r.type !== "hello") throw new Error(errText(r));
    return r;
  }

  async ls() {
    const r = await this.request({ type: "ls" });
    if (r.type !== "sessions") throw new Error(errText(r));
    return r.sessions;
  }

  async spawn(spawn: SpawnRequest) {
    const r = await this.request({ type: "spawn", spawn });
    if (r.type !== "spawned") throw new Error(errText(r));
    return r.info;
  }

  async templates(): Promise<TemplateInfo[]> {
    const r = await this.request({ type: "templates" });
    if (r.type !== "templates") throw new Error(errText(r));
    return r.templates;
  }

  async environments(): Promise<EnvironmentInfo[]> {
    const r = await this.request({ type: "environments" });
    if (r.type !== "environments") throw new Error(errText(r));
    return r.environments;
  }

  async kill(session: string) {
    const r = await this.request({ type: "kill", session });
    if (r.type !== "ok") throw new Error(errText(r));
  }

  close() {
    this.ws.close();
  }
}

function errText(r: Response): string {
  return r.type === "error" ? r.message : `unexpected response: ${r.type}`;
}

export interface AttachHandle {
  send(req: Request): void;
  detach(): void;
}

/** Frames-mode attach on a dedicated connection. */
export async function attachFrames(
  cfg: ConnectionConfig,
  session: string,
  on: {
    frame(frame: Frame): void;
    exited(code: number | null): void;
    error(message: string): void;
    closed(): void;
  },
): Promise<AttachHandle> {
  const ws = await openSocket(cfg);
  ws.onmessage = (ev) => {
    const raw = String(ev.data);
    const t0 = performance.now();
    const resp = JSON.parse(raw) as Response;
    stats.parse.add(performance.now() - t0);
    stats.bytesRate.add(raw.length);
    if (resp.type === "frame") {
      stats.framesRate.add();
      on.frame(resp.frame);
    } else if (resp.type === "exited") on.exited(resp.code);
    else if (resp.type === "error") on.error(resp.message);
  };
  ws.onclose = () => on.closed();
  ws.send(JSON.stringify({ type: "attach", session, mode: "frames" } satisfies Request));
  return {
    send: (req) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(req));
    },
    detach: () => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "detach" } satisfies Request));
      ws.close();
    },
  };
}

/** Lifecycle-event stream on a dedicated connection. */
export async function watchEvents(
  cfg: ConnectionConfig,
  onEvent: (ev: SessionEvent) => void,
): Promise<{ close(): void }> {
  const ws = await openSocket(cfg);
  ws.onmessage = (ev) => {
    const resp = JSON.parse(String(ev.data)) as Response;
    if (resp.type === "event") onEvent(resp.event);
  };
  ws.send(JSON.stringify({ type: "watch" } satisfies Request));
  return { close: () => ws.close() };
}
