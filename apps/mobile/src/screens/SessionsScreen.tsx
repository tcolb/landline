import { LegendList } from "@legendapp/list/react-native";
import { useMutation } from "@tanstack/react-query";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ConnectionConfig } from "../client";
import { SessionInfo } from "../proto";
import { killSession, useSessions } from "../sessions";

interface Props {
  cfg: ConnectionConfig;
  onOpen(session: SessionInfo): void;
  onSpawn(): void;
  onDisconnect(): void;
}

export function SessionsScreen({ cfg, onOpen, onSpawn, onDisconnect }: Props) {
  const sessions = useSessions(cfg);
  const kill = useMutation({
    mutationFn: (id: string) => killSession(cfg, id),
    // No cache surgery needed: the watch event patches the list.
  });

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
          <Pressable style={styles.killBtn} onPress={() => kill.mutate(item.id)}>
            <Text style={styles.killText}>kill</Text>
          </Pressable>
        )}
      </Pressable>
    );
  };

  const error =
    (sessions.error as Error | null)?.message ??
    (kill.error as Error | null)?.message ??
    "";

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
      <LegendList
        data={sessions.data ?? []}
        keyExtractor={(s: SessionInfo) => s.id}
        renderItem={renderItem}
        estimatedItemSize={58}
        recycleItems
        onRefresh={() => sessions.refetch()}
        refreshing={sessions.isFetching}
        ListEmptyComponent={
          <Text style={[styles.dim, styles.empty]}>
            {sessions.isLoading ? "loading…" : "no sessions — spawn one"}
          </Text>
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
