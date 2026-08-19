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
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConnectionConfig } from "./src/client";
import { drawerKit } from "./src/drawer-nav";
import { useScreenRadius } from "./src/screen-radius";
import { IconButton } from "./src/components/IconButton";
import { ConnectScreen } from "./src/screens/ConnectScreen";
import { useSelection } from "./src/selection";
import { SessionDrawer } from "./src/screens/SessionDrawer";
import { SessionHost } from "./src/screens/SessionHost";
import { SessionsScreen } from "./src/screens/SessionsScreen";
import { SpawnScreen } from "./src/screens/SpawnScreen";
import { TerminalScreen } from "./src/screens/TerminalScreen";
import { useConnection } from "./src/store";

const queryClient = new QueryClient();

export type RootStackParams = {
  Connect: undefined;
  Sessions: undefined;
  Spawn: undefined;
  Terminal: { session: string; chat?: boolean };
};

const Stack = createNativeStackNavigator<RootStackParams>();
export const navigationRef = createNavigationContainerRef<RootStackParams>();
const Drawer = drawerKit ? drawerKit.createDrawerNavigator() : null;
/** Nested stack inside the drawer scene so the session bar is the REAL
 * UINavigationBar, not a faked View row. */
const SessionStack = createNativeStackNavigator();

/** Header title view: terminal|chat segmented control for hybrid
 * sessions, otherwise the session name. Lives in the native bar. */
function HeaderToggle() {
  const { selection, view, setView } = useSelection();
  if (!selection) return <Text style={hdrStyles.title}>landline</Text>;
  if (!selection.chat) return <Text style={hdrStyles.title}>{selection.id}</Text>;
  return (
    <View style={hdrStyles.segments}>
      {(["terminal", "chat"] as const).map((v) => (
        <Pressable
          key={v}
          style={[hdrStyles.segment, view === v && hdrStyles.segmentActive]}
          onPress={() => setView(v)}
        >
          <Text style={view === v ? hdrStyles.segTextActive : hdrStyles.segText}>{v}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const hdrStyles = StyleSheet.create({
  title: { color: "#c9d1d9", fontSize: 15, fontWeight: "600" },
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
});

/** Claude-app-style layout: main scene slides right revealing the session
 * drawer; the displaced scene keeps a rounded, bordered edge. */
function DrawerMain({
  cfg,
  onDisconnect,
}: {
  cfg: ConnectionConfig;
  onDisconnect(): void;
}) {
  const { selection, setSelection } = useSelection();
  const screenRadius = useScreenRadius();
  const D = Drawer!;
  return (
    <D.Navigator
      screenOptions={{
        headerShown: false,
        drawerType: "slide",
        // Scrim lives INSIDE the scene (DrawerScrim) so it clips to the
        // card's corner radius; the built-in overlay bleeds past it.
        overlayColor: "transparent",
        drawerStyle: { backgroundColor: "#000000", width: 200 },
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
          onDisconnect={onDisconnect}
        />
      )}
    >
      <D.Screen name="Session">
        {(props: any) => (
          <SessionStack.Navigator>
            <SessionStack.Screen
              name="SessionBar"
              options={{
                headerStyle: { backgroundColor: "#000000" },
                headerShadowVisible: false,
                headerTitle: () => <HeaderToggle />,
                headerLeft: () => (
                  <IconButton
                    symbol="line.3.horizontal"
                    fallback="☰"
                    onPress={() => props.navigation.openDrawer()}
                  />
                ),
              }}
            >
              {() => (
                <SessionHost cfg={cfg} openDrawer={() => props.navigation.openDrawer()} />
              )}
            </SessionStack.Screen>
          </SessionStack.Navigator>
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
                  {() => (
                    <DrawerMain cfg={config} onDisconnect={() => setConnected(false)} />
                  )}
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
