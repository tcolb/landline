import { LegendList } from "@legendapp/list/react-native";
import { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useMutation } from "@tanstack/react-query";
import React, { useLayoutEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { RootStackParams } from "../../App";
import { ConnectionConfig } from "../client";
import { SwiftUI } from "../native-ui";
import { SessionInfo } from "../proto";
import { killSession, useSessions } from "../sessions";

type Props = NativeStackScreenProps<RootStackParams, "Sessions"> & {
  cfg: ConnectionConfig;
  onDisconnect(): void;
};

export function SessionsScreen({ navigation, cfg, onDisconnect }: Props) {
  const sessions = useSessions(cfg);
  const kill = useMutation({
    mutationFn: (id: string) => killSession(cfg, id),
    // No cache surgery needed: the watch event patches the list.
  });

  useLayoutEffect(() => {
    navigation.setOptions({
      title: "Sessions",
      headerLargeTitle: true,
      headerRight: () => (
        <Pressable onPress={() => navigation.navigate("Spawn")} hitSlop={12}>
          <Text style={styles.headerAction}>＋</Text>
        </Pressable>
      ),
      headerLeft: () => (
        <Pressable onPress={onDisconnect} hitSlop={12}>
          <Text style={styles.headerDim}>disconnect</Text>
        </Pressable>
      ),
    });
  }, [navigation, onDisconnect]);

  const open = (s: SessionInfo) => navigation.navigate("Terminal", { session: s.id });
  const detail = (s: SessionInfo) =>
    `${s.environment} · ${s.cmd.join(" ")}${
      s.status.state === "exited" ? ` · exited(${s.status.code ?? "?"})` : ""
    }`;

  if (SwiftUI) {
    const ui = SwiftUI;
    const items = sessions.data ?? [];
    return (
      <ui.Host style={{ flex: 1 }} useViewportSizeMeasurement colorScheme="dark">
        {items.length === 0 ? (
          <ui.ContentUnavailableView
            title={sessions.isLoading ? "Loading…" : "No sessions"}
            systemImage="terminal"
            description={sessions.isLoading ? "" : "Spawn one with the + button"}
          />
        ) : (
          <ui.List>
            {items.map((s) => (
              <ui.SwipeActions key={s.id}>
                <ui.Button onPress={() => open(s)}>
                  <ui.HStack spacing={10}>
                    <ui.Image
                      systemName={
                        s.status.state === "running" ? "circle.fill" : "circle"
                      }
                    />
                    <ui.VStack alignment="leading" spacing={2}>
                      <ui.Text>{`${s.name} (${s.id})`}</ui.Text>
                      <ui.Text>{detail(s)}</ui.Text>
                    </ui.VStack>
                    <ui.Spacer />
                  </ui.HStack>
                </ui.Button>
                {s.status.state === "running" && (
                  <ui.SwipeActions.Actions edge="trailing">
                    <ui.Button
                      role="destructive"
                      label="Kill"
                      onPress={() => kill.mutate(s.id)}
                    />
                  </ui.SwipeActions.Actions>
                )}
              </ui.SwipeActions>
            ))}
          </ui.List>
        )}
      </ui.Host>
    );
  }

  // React Native fallback (Android / pre-module binaries).
  const renderItem = ({ item }: { item: SessionInfo }) => {
    const running = item.status.state === "running";
    return (
      <Pressable style={styles.row} onPress={() => open(item)}>
        <View style={[styles.dot, { backgroundColor: running ? "#3fb950" : "#8b949e" }]} />
        <View style={styles.rowBody}>
          <Text style={styles.name}>
            {item.name} <Text style={styles.dim}>({item.id})</Text>
          </Text>
          <Text style={styles.dim} numberOfLines={1}>
            {detail(item)}
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
  root: { flex: 1, backgroundColor: "#0d1117" },
  headerAction: { color: "#3fb950", fontSize: 22, fontWeight: "600" },
  headerDim: { color: "#8b949e", fontSize: 13 },
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
  error: { color: "#f85149", paddingHorizontal: 16, paddingVertical: 4 },
  killBtn: {
    backgroundColor: "#21262d",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  killText: { color: "#f85149", fontSize: 12 },
});
