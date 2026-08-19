// Main scene of the drawer layout: the selected session, with the
// terminal/chat toggle. Swipe from the left edge (or tap ☰) for the
// session drawer.

import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ConnectionConfig } from "../client";
import { ChatView } from "../components/ChatView";
import { IconButton } from "../components/IconButton";
import { Terminal } from "../components/Terminal";
import { SessionSelection } from "./SessionDrawer";

interface Props {
  cfg: ConnectionConfig;
  selection: SessionSelection | null;
  openDrawer(): void;
}

export function SessionHost({ cfg, selection, openDrawer }: Props) {
  const [view, setView] = useState<"terminal" | "chat">("terminal");

  if (selection === null) {
    return (
      <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyTitle}>No session selected</Text>
          <Pressable onPress={openDrawer} style={styles.emptyBtn}>
            <Text style={styles.emptyBtnText}>Open sessions</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const chatCapable = selection.chat;
  const activeView = chatCapable && view === "chat" ? "chat" : "terminal";

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.bar}>
        <IconButton symbol="line.3.horizontal" fallback="☰" onPress={openDrawer} />
        {chatCapable ? (
          <View style={styles.segments}>
            {(["terminal", "chat"] as const).map((v) => (
              <Pressable
                key={v}
                style={[styles.segment, activeView === v && styles.segmentActive]}
                onPress={() => setView(v)}
              >
                <Text
                  style={activeView === v ? styles.segmentTextActive : styles.segmentText}
                >
                  {v}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <Text style={styles.titleText}>{selection.id}</Text>
        )}
        <View style={{ width: 32 }} />
      </View>
      {activeView === "chat" ? (
        <ChatView cfg={cfg} session={selection.id} />
      ) : (
        <Terminal cfg={cfg} session={selection.id} onBack={openDrawer} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000000" },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  menu: { color: "#c9d1d9", fontSize: 18, width: 24 },
  menuSpacer: { width: 24 },
  titleText: { color: "#8b949e", fontSize: 13 },
  segments: {
    flexDirection: "row",
    backgroundColor: "#141414",
    borderRadius: 8,
    padding: 2,
  },
  segment: { paddingHorizontal: 16, paddingVertical: 5, borderRadius: 6 },
  segmentActive: { backgroundColor: "#1e1e1e" },
  segmentText: { color: "#8b949e", fontSize: 13 },
  segmentTextActive: { color: "#c9d1d9", fontSize: 13, fontWeight: "600" },
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
