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
import { Dimensions, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConnectionConfig } from "./src/client";
import { drawerKit } from "./src/drawer-nav";
import { useScreenRadius } from "./src/screen-radius";
import { ConnectScreen } from "./src/screens/ConnectScreen";
import { useSelection } from "./src/selection";
import { SessionDrawer } from "./src/screens/SessionDrawer";
import { SessionHost } from "./src/screens/SessionHost";
import { SessionsScreen } from "./src/screens/SessionsScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { SpawnScreen } from "./src/screens/SpawnScreen";
import { TerminalScreen } from "./src/screens/TerminalScreen";
import { useConnection } from "./src/store";

const queryClient = new QueryClient();

export type RootStackParams = {
  Connect: undefined;
  Sessions: undefined;
  Spawn: undefined;
  Settings: undefined;
  Terminal: { session: string; chat?: boolean };
};

const Stack = createNativeStackNavigator<RootStackParams>();
export const navigationRef = createNavigationContainerRef<RootStackParams>();
const Drawer = drawerKit ? drawerKit.createDrawerNavigator() : null;


/** Claude-app-style layout: main scene slides right revealing the session
 * drawer; the displaced scene keeps a rounded, bordered edge. */
function DrawerMain({ cfg }: { cfg: ConnectionConfig }) {
  const { selection, setSelection } = useSelection();
  const screenRadius = useScreenRadius();
  const D = Drawer!;
  return (
    <D.Navigator
      screenOptions={{
        headerShown: false,
        // "back": the sidebar sits static underneath and the session view
        // slides over it as a card, rather than both panes sliding together.
        drawerType: "back",
        // Scrim lives INSIDE the scene (DrawerScrim) so it clips to the
        // card's corner radius; the built-in overlay bleeds past it.
        overlayColor: "transparent",
        // Sized so the session card peeking on the right is a slim
        // quarter-screen slice.
        drawerStyle: {
          backgroundColor: "#000000",
          width: Math.round(Dimensions.get("window").width * 0.75),
        },
        sceneStyle: {
          backgroundColor: "#000000",
          // Matches the device's physical display corner radius (same
          // trick X/Claude/ChatGPT use), so closed-state corners coincide
          // with the hardware and the card only "appears" when displaced.
          borderRadius: screenRadius,
          overflow: "hidden",
        },
        swipeEdgeWidth: 80,
      }}
      drawerContent={(props) => (
        <SessionDrawer
          cfg={cfg}
          selected={selection?.id ?? null}
          onSelect={(sel) => {
            setSelection(sel);
            props.navigation.closeDrawer();
          }}
          onSpawn={() => {
            props.navigation.closeDrawer();
            navigationRef.navigate("Spawn");
          }}
          onSettings={() => {
            props.navigation.closeDrawer();
            navigationRef.navigate("Settings");
          }}
        />
      )}
    >
      <D.Screen name="Session">
        {(props: any) => (
          <SessionHost cfg={cfg} openDrawer={() => props.navigation.openDrawer()} />
        )}
      </D.Screen>
    </D.Navigator>
  );
}

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: "#000000",
    card: "#000000",
    text: "#c9d1d9",
    primary: "#3fb950",
    border: "#1e1e1e",
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

  const Root = drawerKit?.GestureHandlerRootView ?? React.Fragment;
  const rootProps = drawerKit ? { style: { flex: 1 } } : {};
  return (
    <Root {...rootProps}>
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
            ) : Drawer !== null ? (
              <Stack.Navigator>
                <Stack.Screen name="Sessions" options={{ headerShown: false }}>
                  {() => <DrawerMain cfg={config} />}
                </Stack.Screen>
                <Stack.Screen
                  name="Spawn"
                  options={{ presentation: "modal", title: "New Session" }}
                >
                  {(props) => (
                    <SpawnScreen
                      {...props}
                      cfg={config}
                      onSpawned={(info) => {
                        useSelection
                          .getState()
                          .setSelection({ id: info.id, chat: info.chat === true });
                        props.navigation.goBack();
                      }}
                    />
                  )}
                </Stack.Screen>
                <Stack.Screen
                  name="Settings"
                  options={{ presentation: "modal", title: "Settings" }}
                >
                  {() => (
                    <SettingsScreen cfg={config} onDisconnect={() => setConnected(false)} />
                  )}
                </Stack.Screen>
                <Stack.Screen name="Terminal" options={{ headerShown: false }}>
                  {(props) => <TerminalScreen {...props} cfg={config} />}
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
    </Root>
  );
}

const styles = StyleSheet.create({
  crash: { flex: 1, backgroundColor: "#000000", padding: 16 },
  crashTitle: { color: "#f85149", fontSize: 18, fontWeight: "600", marginBottom: 8 },
  crashText: { color: "#c9d1d9", fontFamily: "monospace", fontSize: 12 },
});
