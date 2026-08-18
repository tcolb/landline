import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ConnectionConfig, ControlConn, watchEvents } from "../client";
import { SessionInfo } from "../proto";

interface Props {
  cfg: ConnectionConfig;
  onOpen(session: SessionInfo): void;
  onSpawn(): void;
  onDisconnect(): void;
}

export function SessionsScreen({ cfg, onOpen, onSpawn, onDisconnect }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const conn = useRef<ControlConn | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (!conn.current) conn.current = await ControlConn.open(cfg);
      setSessions(await conn.current.ls());
      setError("");
    } catch (e: any) {
      conn.current = null;
      setError(String(e.message ?? e));
    } finally {
      setRefreshing(false);
    }
  }, [cfg]);

  // Live list: watch events patch state; ls covers the initial load.
  useEffect(() => {
    refresh();
    let closer: { close(): void } | null = null;
    let alive = true;
    watchEvents(cfg, (ev) => {
      setSessions((prev) => {
        const rest = prev.filter((s) => s.id !== ev.info.id);
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
      conn.current?.close();
      conn.current = null;
    };
  }, [cfg, refresh]);

  const kill = async (s: SessionInfo) => {
    try {
      if (!conn.current) conn.current = await ControlConn.open(cfg);
      await conn.current.kill(s.id);
    } catch (e: any) {
      setError(String(e.message ?? e));
    }
  };

  const renderItem = ({ item }: { item: SessionInfo }) => {
    const running = item.status.state === "running";
    return (
      <Pressable style={styles.row} onPress={() => onOpen(item)}>
        <View style={[styles.dot, { backgroundColor: running ? "#3fb950" : "#8b949e" }]} />
        <View style={styles.rowBody}>
          <Text style={styles.name}>
            {item.name} <Text style={styles.dim}>({item.id})</Text>
          </Text>
          <Text style={styles.dim} numberOfLines={1}>
            {item.environment} · {item.cmd.join(" ")}
            {item.status.state === "exited" ? ` · exited(${item.status.code ?? "?"})` : ""}
          </Text>
        </View>
        {running && (
          <Pressable style={styles.killBtn} onPress={() => kill(item)}>
            <Text style={styles.killText}>kill</Text>
          </Pressable>
        )}
      </Pressable>
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>sessions</Text>
        <View style={styles.headerBtns}>
          <Pressable style={styles.btn} onPress={onSpawn}>
            <Text style={styles.btnText}>+ spawn</Text>
          </Pressable>
          <Pressable style={styles.btnGhost} onPress={onDisconnect}>
            <Text style={styles.dim}>disconnect</Text>
          </Pressable>
        </View>
      </View>
      {error !== "" && <Text style={styles.error}>{error}</Text>}
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        renderItem={renderItem}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        ListEmptyComponent={
          <Text style={[styles.dim, styles.empty]}>no sessions — spawn one</Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0d1117", paddingTop: 8 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  headerBtns: { flexDirection: "row", gap: 12, alignItems: "center" },
  title: { color: "#c9d1d9", fontSize: 20, fontWeight: "600" },
  btn: {
    backgroundColor: "#238636",
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  btnGhost: { paddingVertical: 6 },
  btnText: { color: "#fff", fontWeight: "600" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#21262d",
    gap: 10,
  },
  rowBody: { flex: 1 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  name: { color: "#c9d1d9", fontSize: 15 },
  dim: { color: "#8b949e", fontSize: 12 },
  empty: { textAlign: "center", marginTop: 48 },
  error: { color: "#f85149", paddingHorizontal: 16, paddingBottom: 4 },
  killBtn: {
    backgroundColor: "#21262d",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  killText: { color: "#f85149", fontSize: 12 },
});
