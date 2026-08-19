import { NativeStackScreenProps } from "@react-navigation/native-stack";
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { RootStackParams } from "../../App";
import { ConnectionConfig } from "../client";
import { ChatView } from "../components/ChatView";
import { Terminal } from "../components/Terminal";

type Props = NativeStackScreenProps<RootStackParams, "Terminal"> & {
  cfg: ConnectionConfig;
};

export function TerminalScreen({ route, navigation, cfg }: Props) {
  const { session, chat } = route.params;
  const [view, setView] = useState<"terminal" | "chat">("terminal");

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      {chat && (
        <View style={styles.toggleRow}>
          <Pressable onPress={() => navigation.goBack()} hitSlop={12}>
            <Text style={styles.back}>‹</Text>
          </Pressable>
          <View style={styles.segments}>
            {(["terminal", "chat"] as const).map((v) => (
              <Pressable
                key={v}
                style={[styles.segment, view === v && styles.segmentActive]}
                onPress={() => setView(v)}
              >
                <Text style={view === v ? styles.segmentTextActive : styles.segmentText}>
                  {v}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.backSpacer} />
        </View>
      )}
      {view === "chat" && chat ? (
        <ChatView cfg={cfg} session={session} />
      ) : (
        <Terminal cfg={cfg} session={session} onBack={() => navigation.goBack()} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000000" },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  back: { color: "#58a6ff", fontSize: 24, width: 24 },
  backSpacer: { width: 24 },
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
});
