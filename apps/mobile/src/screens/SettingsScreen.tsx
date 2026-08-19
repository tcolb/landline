// Settings modal (native pageSheet, like the New Session overlay):
// connection info + disconnect. SwiftUI Form on iOS, RN fallback.

import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ConnectionConfig } from "../client";
import { SwiftUI, SwiftUIModifiers } from "../native-ui";

interface Props {
  cfg: ConnectionConfig;
  onDisconnect(): void;
}

export function SettingsScreen({ cfg, onDisconnect }: Props) {
  if (SwiftUI !== null && SwiftUIModifiers !== null) {
    const m = SwiftUIModifiers;
    return (
      <SwiftUI.Host style={{ flex: 1 }} colorScheme="dark" useViewportSizeMeasurement>
        <SwiftUI.Form>
          <SwiftUI.Section title="Connection">
            <SwiftUI.LabeledContent label="Daemon">
              <SwiftUI.Text>{cfg.host}</SwiftUI.Text>
            </SwiftUI.LabeledContent>
          </SwiftUI.Section>
          <SwiftUI.Section>
            <SwiftUI.Button
              role="destructive"
              label="Disconnect"
              systemImage="bolt.slash"
              onPress={onDisconnect}
              modifiers={[m.foregroundColor("#f85149")]}
            />
          </SwiftUI.Section>
        </SwiftUI.Form>
      </SwiftUI.Host>
    );
  }
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.body}>
      <View style={styles.card}>
        <Text style={styles.dim}>Daemon</Text>
        <Text style={styles.value}>{cfg.host}</Text>
      </View>
      <Pressable onPress={onDisconnect} style={styles.card}>
        <Text style={styles.danger}>Disconnect</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000000" },
  body: { padding: 16, gap: 12 },
  card: { backgroundColor: "#161b22", borderRadius: 10, padding: 14 },
  dim: { color: "#8b949e", fontSize: 13 },
  value: { color: "#c9d1d9", fontSize: 15, marginTop: 2 },
  danger: { color: "#f85149", fontSize: 15, fontWeight: "600" },
});
