import {
  DarkTheme,
  NavigationContainer,
  createNavigationContainerRef,
} from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConnectionConfig } from "./src/client";
import { ConnectScreen } from "./src/screens/ConnectScreen";
import { SessionsScreen } from "./src/screens/SessionsScreen";
import { SpawnScreen } from "./src/screens/SpawnScreen";
import { TerminalScreen } from "./src/screens/TerminalScreen";
import { useConnection } from "./src/store";

const queryClient = new QueryClient();

export type RootStackParams = {
  Connect: undefined;
  Sessions: undefined;
  Spawn: undefined;
  Terminal: { session: string };
};

const Stack = createNativeStackNavigator<RootStackParams>();
export const navigationRef = createNavigationContainerRef<RootStackParams>();

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: "#0d1117",
    card: "#0d1117",
    text: "#c9d1d9",
    primary: "#3fb950",
    border: "#21262d",
  },
};

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

/** True while the user has an active, hello-verified connection this run.
 * Kept here (module state via zustand would persist; this must not). */
export function useConnected() {
  const { config } = useConnection();
  const [connected, setConnected] = useState(false);
  return { config, connected, setConnected };
}

export default function App() {
  const { config, hydrated, setConfig } = useConnection();
  const [connected, setConnected] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);

  // CI-only: EXPO_PUBLIC_AUTOTEST / Constants extra drive straight into a
  // terminal against the mock daemon (never set in shipped builds).
  useEffect(() => {
    if (!hydrated) return;
    const autotest =
      process.env.EXPO_PUBLIC_AUTOTEST === "1" ||
      Constants.expoConfig?.extra?.autotest === "1";
    if (autotest) {
      setConfig({ host: "127.0.0.1:7181", token: "autotest" });
      setConnected(true);
      const t = setInterval(() => {
        if (navigationRef.isReady()) {
          clearInterval(t);
          navigationRef.navigate("Terminal", { session: "s1" });
        }
      }, 100);
      return () => clearInterval(t);
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
      <ScrollView style={styles.crash}>
        <Text style={styles.crashTitle}>landline crashed</Text>
        <Text style={styles.crashText}>{fatal}</Text>
      </ScrollView>
    );
  }
  if (!hydrated) return null;

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="light" />
        <ErrorBoundary>
          <NavigationContainer ref={navigationRef} theme={theme}>
            {!connected || !config ? (
              <Stack.Navigator>
                <Stack.Screen name="Connect" options={{ headerShown: false }}>
                  {() => (
                    <ConnectScreen
                      initial={config ?? { host: "", token: "" }}
                      onConnected={(c: ConnectionConfig) => {
                        setConfig(c);
                        setConnected(true);
                      }}
                    />
                  )}
                </Stack.Screen>
              </Stack.Navigator>
            ) : (
              <Stack.Navigator>
                <Stack.Screen name="Sessions">
                  {(props) => (
                    <SessionsScreen
                      {...props}
                      cfg={config}
                      onDisconnect={() => setConnected(false)}
                    />
                  )}
                </Stack.Screen>
                <Stack.Screen
                  name="Spawn"
                  options={{ presentation: "modal", title: "New Session" }}
                >
                  {(props) => <SpawnScreen {...props} cfg={config} />}
                </Stack.Screen>
                <Stack.Screen name="Terminal" options={{ headerShown: false }}>
                  {(props) => <TerminalScreen {...props} cfg={config} />}
                </Stack.Screen>
              </Stack.Navigator>
            )}
          </NavigationContainer>
        </ErrorBoundary>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  crash: { flex: 1, backgroundColor: "#0d1117", padding: 16 },
  crashTitle: { color: "#f85149", fontSize: 18, fontWeight: "600", marginBottom: 8 },
  crashText: { color: "#c9d1d9", fontFamily: "monospace", fontSize: 12 },
});
