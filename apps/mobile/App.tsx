import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useState } from "react";
import { SafeAreaView, ScrollView, StyleSheet, Text } from "react-native";
import { ConnectionConfig } from "./src/client";
import { SessionInfo } from "./src/proto";
import { ConnectScreen } from "./src/screens/ConnectScreen";
import { SessionsScreen } from "./src/screens/SessionsScreen";
import { SpawnScreen } from "./src/screens/SpawnScreen";
import { useConnection } from "./src/store";

const queryClient = new QueryClient();

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
  const { config, hydrated, setConfig, clearConfig } = useConnection();
  // Connected = the user passed the connect screen this run; config alone
  // persists across restarts and only prefills the form.
  const [connected, setConnected] = useState(false);
  const [screen, setScreen] = useState<Screen>({ name: "connect" });
  const [fatal, setFatal] = useState<string | null>(null);

  // CI-only: EXPO_PUBLIC_AUTOTEST is inlined at bundle time for the
  // simulator smoke build (never the shipped ipa); it drives straight into
  // a terminal against the mock daemon on the runner. Must wait for store
  // hydration: rehydrating from empty storage after this effect would
  // clobber the config back to null and land on the connect screen.
  useEffect(() => {
    if (!hydrated) return;
    const autotest =
      process.env.EXPO_PUBLIC_AUTOTEST === "1" ||
      Constants.expoConfig?.extra?.autotest === "1";
    if (autotest) {
      setConfig({ host: "127.0.0.1:7181", token: "autotest" });
      setConnected(true);
      setScreen({ name: "terminal", session: "s1" });
    }
  }, [hydrated, setConfig]);

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

  const body = () => {
    if (!hydrated) return null;
    if (!connected || !config || screen.name === "connect")
      return (
        <ConnectScreen
          initial={config ?? { host: "", token: "" }}
          onConnected={(c) => {
            setConfig(c);
            setConnected(true);
            setScreen({ name: "sessions" });
          }}
        />
      );
    switch (screen.name) {
      case "sessions":
        return (
          <SessionsScreen
            cfg={config}
            onOpen={(s: SessionInfo) => setScreen({ name: "terminal", session: s.id })}
            onSpawn={() => setScreen({ name: "spawn" })}
            onDisconnect={() => {
              // Back to the connect screen; keep the saved config as prefill.
              setConnected(false);
              setScreen({ name: "connect" });
            }}
          />
        );
      case "spawn":
        return (
          <SpawnScreen
            cfg={config}
            onSpawned={(info) => setScreen({ name: "terminal", session: info.id })}
            onBack={() => setScreen({ name: "sessions" })}
          />
        );
      case "terminal":
        return (
          <LazyTerminal
            cfg={config}
            session={screen.session}
            onBack={() => setScreen({ name: "sessions" })}
          />
        );
    }
  };

  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaView style={styles.root}>
        <StatusBar style="light" />
        <ErrorBoundary>{body()}</ErrorBoundary>
      </SafeAreaView>
    </QueryClientProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0d1117" },
  crash: { flex: 1, backgroundColor: "#0d1117", padding: 16 },
  crashTitle: { color: "#f85149", fontSize: 18, fontWeight: "600", marginBottom: 8 },
  crashText: { color: "#c9d1d9", fontFamily: "monospace", fontSize: 12 },
});
