// The left drawer: sessions + spawn + disconnect — the app's home base in
// the drawer layout. Selecting a session swaps the main scene in place.

import { LegendList } from "@legendapp/list/react-native";
import { useMutation } from "@tanstack/react-query";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ConnectionConfig } from "../client";
import { DrawerRevealFx } from "../components/DrawerScrim";
import { GlassPillButton, IconButton } from "../components/IconButton";
import { SessionInfo } from "../proto";
import { killSession, useSessions } from "../sessions";

export interface SessionSelection {
  id: string;
  chat: boolean;
}

interface Props {
  cfg: ConnectionConfig;
  selected: string | null;
  onSelect(sel: SessionSelection): void;
  onSpawn(): void;
  onSettings(): void;
}

export function SessionDrawer({ cfg, selected, onSelect, onSpawn, onSettings }: Props) {
  const sessions = useSessions(cfg);
  const kill = useMutation({ mutationFn: (id: string) => killSession(cfg, id) });

  const renderItem = ({ item }: { item: SessionInfo }) => {
    const running = item.status.state === "running";
    const active = item.id === selected;
    return (
      <Pressable
        style={[styles.row, active && styles.rowActive]}
        onPress={() => onSelect({ id: item.id, chat: item.chat === true })}
        onLongPress={() => running && kill.mutate(item.id)}
      >
        <View style={[styles.dot, { backgroundColor: running ? "#3fb950" : "#8b949e" }]} />
        <View style={styles.rowBody}>
          <Text style={styles.name} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={styles.dim} numberOfLines={1}>
            {item.cmd.join(" ")}
            {item.status.state === "exited" ? ` · exited(${item.status.code ?? "?"})` : ""}
          </Text>
        </View>
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "left"]}>
      <DrawerRevealFx>
      <View style={styles.header}>
        <Text style={styles.title}>landline</Text>
      </View>
      <LegendList
        data={sessions.data ?? []}
        keyExtractor={(s: SessionInfo) => s.id}
        renderItem={renderItem}
        estimatedItemSize={54}
        recycleItems
        ListEmptyComponent={
          <Text style={[styles.dim, styles.empty]}>
            {sessions.isLoading ? "loading…" : "no sessions"}
          </Text>
        }
      />
      <View style={styles.gear}>
        <IconButton symbol="gearshape" fallback="⚙" onPress={onSettings} />
      </View>
      <View style={styles.fab}>
        <GlassPillButton label="New Session" symbol="plus" onPress={onSpawn} />
      </View>
      </DrawerRevealFx>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000000" },
  // Bottom controls nestle into the screen bottom (no safe-area lift):
  // the gear clears the display's rounded corner, the pill mirrors it.
  fab: { position: "absolute", right: 14, bottom: 14 },
  gear: { position: "absolute", left: 18, bottom: 18 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { color: "#c9d1d9", fontSize: 18, fontWeight: "700" },
  newBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#238636",
    alignItems: "center",
    justifyContent: "center",
  },
  newText: { color: "#fff", fontSize: 18, fontWeight: "600" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginHorizontal: 6,
    borderRadius: 8,
  },
  rowActive: { backgroundColor: "#141414" },
  rowBody: { flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  name: { color: "#c9d1d9", fontSize: 14, fontWeight: "500" },
  dim: { color: "#8b949e", fontSize: 11 },
  empty: { textAlign: "center", marginTop: 40 },
  footer: { padding: 16 },
});
