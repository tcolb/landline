// Main scene content of the drawer layout: the selected session. The top
// bar is a compact custom row INSIDE the rounded card (the genre-app
// pattern — UINavigationBar can't live inside a displaced card without
// forcing its own safe-area block above the corner radius).

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ConnectionConfig } from "../client";
import { ChatView } from "../components/ChatView";
import { DrawerScrim } from "../components/DrawerScrim";
import { IconButton } from "../components/IconButton";
import { SwiftUI, SwiftUIModifiers } from "../native-ui";
import { Terminal } from "../components/Terminal";
import { useSelection } from "../selection";
import { dismissAllKeyboards } from "../kb";
import { drawerKit } from "../drawer-nav";

/** Bump on every UI change batch; shows in the dev bar so a stale bundle
 * is immediately visible on-device. */
const JS_REV = "r34";

interface Props {
  cfg: ConnectionConfig;
  openDrawer(): void;
}

function TopBar({ openDrawer }: { openDrawer(): void }) {
  const { selection, view, setView } = useSelection();
  return (
    <View style={styles.bar}>
      <IconButton
        symbol="line.3.horizontal"
        fallback="☰"
        onPress={() => {
          dismissAllKeyboards();
          openDrawer();
        }}
      />
      <View style={styles.barCenter}>
        {selection?.chat ? (
          SwiftUI !== null && SwiftUIModifiers !== null ? (
            <SwiftUI.Host style={{ width: 190, height: 44 }} colorScheme="dark">
              <SwiftUI.Picker
                selection={view}
                onSelectionChange={(v) => setView(v as "terminal" | "chat")}
                modifiers={[
                  SwiftUIModifiers.pickerStyle("segmented"),
                  // Segmented controls have a fixed intrinsic height that
                  // frame() cannot stretch; large control size matches the
                  // 44pt bar buttons.
                  SwiftUIModifiers.controlSize("large"),
                  SwiftUIModifiers.frame({ width: 190, height: 44 }),
                ]}
              >
                <SwiftUI.Text modifiers={[SwiftUIModifiers.tag("terminal")]}>
                  terminal
                </SwiftUI.Text>
                <SwiftUI.Text modifiers={[SwiftUIModifiers.tag("chat")]}>chat</SwiftUI.Text>
              </SwiftUI.Picker>
            </SwiftUI.Host>
          ) : (
          <View style={styles.segments}>
            {(["terminal", "chat"] as const).map((v) => (
              <Pressable
                key={v}
                style={[styles.segment, view === v && styles.segmentActive]}
                onPress={() => setView(v)}
              >
                <Text style={view === v ? styles.segTextActive : styles.segText}>{v}</Text>
              </Pressable>
            ))}
          </View>
          )
        ) : (
          <Text style={styles.title}>{selection ? selection.id : "landline"}</Text>
        )}
      </View>
      {/* Balance the menu button so the center stays centered. In dev,
          doubles as a bundle-freshness stamp. */}
      <View style={{ width: 44, alignItems: "center", justifyContent: "center" }}>
        {__DEV__ && <Text style={styles.stamp}>{JS_REV}</Text>}
      </View>
    </View>
  );
}

/** Worklet-free fallback: drop keyboards whenever the drawer's nav state
 * flips to open (covers gesture opens even if the progress worklet path
 * fails). Rendered only when the drawer stack is available so the hook
 * call is unconditional within it. */
function DismissOnDrawerOpen() {
  const status = drawerKit!.useDrawerStatus!();
  React.useEffect(() => {
    if (status === "open") dismissAllKeyboards();
  }, [status]);
  return null;
}

export function SessionHost({ cfg, openDrawer }: Props) {
  const { selection, view } = useSelection();
  // Inset padding, not SafeAreaView: SafeAreaView re-measures during the
  // drawer's slide animation and visibly jumps.
  const insets = useSafeAreaInsets();

  const activeView = selection?.chat && view === "chat" ? "chat" : "terminal";
  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {drawerKit?.useDrawerStatus !== undefined && <DismissOnDrawerOpen />}
      <TopBar openDrawer={openDrawer} />
      {selection === null ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyTitle}>No session selected</Text>
          <Pressable onPress={openDrawer} style={styles.emptyBtn}>
            <Text style={styles.emptyBtnText}>Open sessions</Text>
          </Pressable>
        </View>
      ) : activeView === "chat" ? (
        <ChatView cfg={cfg} session={selection.id} />
      ) : (
        <Terminal cfg={cfg} session={selection.id} onBack={openDrawer} showBack={false} />
      )}
      <DrawerScrim />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000000" },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  barCenter: { flex: 1, alignItems: "center" },
  title: { color: "#c9d1d9", fontSize: 15, fontWeight: "600" },
  stamp: { color: "#30363d", fontSize: 10 },
  segments: {
    flexDirection: "row",
    backgroundColor: "#141414",
    borderRadius: 8,
    padding: 2,
  },
  segment: { paddingHorizontal: 14, paddingVertical: 4, borderRadius: 6 },
  segmentActive: { backgroundColor: "#2a2a2a" },
  segText: { color: "#8b949e", fontSize: 13 },
  segTextActive: { color: "#c9d1d9", fontSize: 13, fontWeight: "600" },
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
