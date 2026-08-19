import Constants from "expo-constants";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ConnectionConfig, ControlConn } from "../client";
import { SwiftUI } from "../native-ui";

interface Props {
  initial: ConnectionConfig;
  onConnected(cfg: ConnectionConfig): void;
}

export function ConnectScreen(props: Props) {
  return SwiftUI ? <NativeConnect {...props} /> : <LegacyConnect {...props} />;
}

/** Native-first variant: a real SwiftUI Form (grouped inset styling,
 * system keyboard behaviors, dynamic type). */
function NativeConnect({ initial, onConnected }: Props) {
  const ui = SwiftUI!;
  const hostState = ui.useNativeState(initial.host);
  const tokenState = ui.useNativeState(initial.token);
  const host = React.useRef(initial.host);
  const token = React.useRef(initial.token);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const connect = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    const cfg = { host: host.current.trim(), token: token.current.trim() };
    try {
      const conn = await ControlConn.open(cfg);
      const hello = await conn.hello();
      conn.close();
      if (hello.version !== 1) throw new Error(`protocol v${hello.version} unsupported`);
      onConnected(cfg);
    } catch (e: any) {
      setError(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ui.Host style={{ flex: 1 }} useViewportSizeMeasurement colorScheme="dark">
      <ui.Form>
        <ui.Section title="landline">
          <ui.Text>{`v${Constants.expoConfig?.version ?? "?"} — connect to a daemon started with --ws`}</ui.Text>
        </ui.Section>
        <ui.Section title="Daemon">
          <ui.TextField
            placeholder="host:port, e.g. 192.168.1.10:7070"
            text={hostState}
            onTextChange={(t) => (host.current = t)}
            autoFocus={initial.host === ""}
          />
          <ui.TextField
            placeholder="token (~/.local/share/landline/ws-token)"
            text={tokenState}
            onTextChange={(t) => (token.current = t)}
          />
        </ui.Section>
        {error !== "" && (
          <ui.Section title="Error">
            <ui.Text>{error}</ui.Text>
          </ui.Section>
        )}
        <ui.Section>
          <ui.Button label={busy ? "Connecting…" : "Connect"} onPress={connect} />
        </ui.Section>
      </ui.Form>
    </ui.Host>
  );
}

function LegacyConnect({ initial, onConnected }: Props) {
  const [host, setHost] = useState(initial.host);
  const [token, setToken] = useState(initial.token);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const connect = async () => {
    setBusy(true);
    setError("");
    const cfg = { host: host.trim(), token: token.trim() };
    try {
      const conn = await ControlConn.open(cfg);
      const hello = await conn.hello();
      conn.close();
      if (hello.version !== 1) throw new Error(`protocol v${hello.version} unsupported`);
      onConnected(cfg);
    } catch (e: any) {
      setError(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <Text style={styles.title}>landline</Text>
      <Text style={styles.version}>v{Constants.expoConfig?.version ?? "?"}</Text>
      <Text style={styles.label}>daemon host:port (landline daemon --ws …)</Text>
      <TextInput
        style={styles.input}
        value={host}
        onChangeText={setHost}
        placeholder="192.168.1.10:7070"
        placeholderTextColor="#484f58"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Text style={styles.label}>token (~/.local/share/landline/ws-token)</Text>
      <TextInput
        style={styles.input}
        value={token}
        onChangeText={setToken}
        placeholder="hex token"
        placeholderTextColor="#484f58"
        autoCapitalize="none"
        autoCorrect={false}
      />
      {error !== "" && <Text style={styles.error}>{error}</Text>}
      <Pressable style={styles.button} onPress={connect} disabled={busy}>
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>connect</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0d1117", padding: 24, justifyContent: "center" },
  title: {
    color: "#c9d1d9",
    fontSize: 28,
    fontWeight: "600",
    marginBottom: 4,
    textAlign: "center",
  },
  version: { color: "#484f58", fontSize: 12, textAlign: "center", marginBottom: 24 },
  label: { color: "#8b949e", fontSize: 12, marginBottom: 4 },
  input: {
    backgroundColor: "#161b22",
    color: "#c9d1d9",
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
    fontFamily: "monospace",
  },
  error: { color: "#f85149", marginBottom: 12 },
  button: {
    backgroundColor: "#238636",
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
  },
  buttonText: { color: "#fff", fontWeight: "600" },
});
