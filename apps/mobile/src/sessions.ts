// Server state: the session list as a TanStack Query, kept live by the
// protocol's watch events patching the cache (ls only runs for initial
// load and manual refresh).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { ConnectionConfig, ControlConn, watchEvents } from "./client";
import { SessionInfo } from "./proto";

export const sessionsKey = (cfg: ConnectionConfig) => ["sessions", cfg.host];

export function useSessions(cfg: ConnectionConfig) {
  const client = useQueryClient();

  const query = useQuery({
    queryKey: sessionsKey(cfg),
    queryFn: async () => {
      const conn = await ControlConn.open(cfg);
      try {
        return await conn.ls();
      } finally {
        conn.close();
      }
    },
    staleTime: 10_000,
  });

  useEffect(() => {
    let closer: { close(): void } | null = null;
    let alive = true;
    watchEvents(cfg, (ev) => {
      client.setQueryData<SessionInfo[]>(sessionsKey(cfg), (prev) => {
        const rest = (prev ?? []).filter((s) => s.id !== ev.info.id);
        return [...rest, ev.info].sort((a, b) => a.id.localeCompare(b.id));
      });
    })
      .then((c) => {
        if (!alive) c.close();
        else closer = c;
      })
      .catch(() => {});
    return () => {
      alive = false;
      closer?.close();
    };
  }, [client, cfg]);

  return query;
}

export function useTemplates(cfg: ConnectionConfig) {
  return useQuery({
    queryKey: ["templates", cfg.host],
    queryFn: async () => {
      const conn = await ControlConn.open(cfg);
      try {
        return await conn.templates();
      } finally {
        conn.close();
      }
    },
    staleTime: 60_000,
  });
}

export function useEnvironments(cfg: ConnectionConfig) {
  return useQuery({
    queryKey: ["environments", cfg.host],
    queryFn: async () => {
      const conn = await ControlConn.open(cfg);
      try {
        return await conn.environments();
      } finally {
        conn.close();
      }
    },
    staleTime: 60_000,
  });
}

export async function killSession(cfg: ConnectionConfig, session: string) {
  const conn = await ControlConn.open(cfg);
  try {
    await conn.kill(session);
  } finally {
    conn.close();
  }
}
