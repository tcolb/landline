import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useState } from "react";
import { SafeAreaView, ScrollView, StyleSheet, Text } from "react-native";
import { ConnectionConfig } from "./src/client";
import { SessionInfo } from "./src/proto";
import { ConnectScreen } from "./src/screens/ConnectScreen";
import { SessionsScreen } from "./src/screens/SessionsScreen";
import { SpawnScreen } from "./src/screens/SpawnScreen";

// The terminal pulls in the Skia native module; loading it lazily keeps a
// broken native module from black-screening the whole app at bundle eval —
// the failure surfaces in the ErrorBoundary when the terminal opens instead.
function LazyTerminal(props: {
  cfg: ConnectionConfig;
  session: string;
  onBack(): void;
}) {
  const { Terminal } = require("./src/components/Terminal") as
    typeof import("./src/components/Terminal");
  return <Terminal {...props} />;
}

const CONFIG_KEY = "landline.connection";

/** Release builds have no dev overlay; render crashes as text rather than
 * dying to a black screen. */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      const e = this.state.error;
      return (
        <ScrollView style={styles.crash}>
          <Text style={styles.crashTitle}>landline crashed</Text>
          <Text style={styles.crashText}>
            {String(e.message ?? e)}
            {"\n\n"}
            {e.stack ?? ""}
          </Text>
        </ScrollView>
      );
    }
    return this.props.children;
  }
}

type Screen =
  | { name: "connect" }
  | { name: "sessions" }
  | { name: "spawn" }
  | { name: "terminal"; session: string };

export default function App() {
  const [cfg, setCfg] = useState<ConnectionConfig | null>(null);
  const [initial, setInitial] = useState<ConnectionConfig>({ host: "", token: "" });
  const [screen, setScreen] = useState<Screen>({ name: "connect" });
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(CONFIG_KEY).then((raw) => {
      if (raw) setInitial(JSON.parse(raw));
    });
  }, []);

  // Uncaught errors outside render (event handlers, timers, WS callbacks)
  // bypass the ErrorBoundary; surface them as text too.
  useEffect(() => {
    const utils = (globalThis as any).ErrorUtils;
    if (!utils?.setGlobalHandler) return;
    const prev = utils.getGlobalHandler?.();
    utils.setGlobalHandler((e: any, isFatal?: boolean) => {
      setFatal(`${String(e?.message ?? e)}\n\n${e?.stack ?? ""}`);
      prev?.(e, isFatal);
    });
    return () => prev && utils.setGlobalHandler(prev);
  }, []);

  if (fatal) {
    return (
      <SafeAreaView style={styles.root}>
        <ScrollView style={styles.crash}>
          <Text style={styles.crashTitle}>landline crashed</Text>
          <Text style={styles.crashText}>{fatal}</Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  const connected = (c: ConnectionConfig) => {
    setCfg(c);
    AsyncStorage.setItem(CONFIG_KEY, JSON.stringify(c));
    setScreen({ name: "sessions" });
  };

  const body = () => {
    if (!cfg || screen.name === "connect")
      return <ConnectScreen initial={initial} onConnected={connected} />;
    switch (screen.name) {
      case "sessions":
        return (
          <SessionsScreen
            cfg={cfg}
            onOpen={(s: SessionInfo) => setScreen({ name: "terminal", session: s.id })}
            onSpawn={() => setScreen({ name: "spawn" })}
            onDisconnect={() => {
              setCfg(null);
              setScreen({ name: "connect" });
            }}
          />
        );
      case "spawn":
        return (
          <SpawnScreen
            cfg={cfg}
            onSpawned={(info) => setScreen({ name: "terminal", session: info.id })}
            onBack={() => setScreen({ name: "sessions" })}
          />
        );
      case "terminal":
        return (
          <LazyTerminal
            cfg={cfg}
            session={screen.session}
            onBack={() => setScreen({ name: "sessions" })}
          />
        );
    }
  };

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      <ErrorBoundary>{body()}</ErrorBoundary>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0d1117" },
  crash: { flex: 1, backgroundColor: "#0d1117", padding: 16 },
  crashTitle: { color: "#f85149", fontSize: 18, fontWeight: "600", marginBottom: 8 },
  crashText: { color: "#c9d1d9", fontFamily: "monospace", fontSize: 12 },
});
