// Main scene content of the drawer layout: the selected session. The top
// bar is the REAL UINavigationBar (nested native stack in App.tsx); this
// component is content-only, plus the in-scene drawer scrim.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ConnectionConfig } from "../client";
import { ChatView } from "../components/ChatView";
import { DrawerScrim } from "../components/DrawerScrim";
import { Terminal } from "../components/Terminal";
import { useSelection } from "../selection";

interface Props {
  cfg: ConnectionConfig;
  openDrawer(): void;
}

export function SessionHost({ cfg, openDrawer }: Props) {
  const { selection, view } = useSelection();

  if (selection === null) {
    return (
      <View style={styles.root}>
        <DrawerScrim />
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyTitle}>No session selected</Text>
          <Pressable onPress={openDrawer} style={styles.emptyBtn}>
            <Text style={styles.emptyBtnText}>Open sessions</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const activeView = selection.chat && view === "chat" ? "chat" : "terminal";
  return (
    <View style={styles.root}>
      <DrawerScrim />
      {activeView === "chat" ? (
        <ChatView cfg={cfg} session={selection.id} />
      ) : (
        <Terminal cfg={cfg} session={selection.id} onBack={openDrawer} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000000" },
  emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  emptyTitle: { color: "#8b949e", fontSize: 16 },
  emptyBtn: {
    backgroundColor: "#238636",
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  emptyBtnText: { color: "#fff", fontWeight: "600" },
});
