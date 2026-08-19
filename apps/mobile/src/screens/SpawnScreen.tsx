import { NativeStackScreenProps } from "@react-navigation/native-stack";
import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { RootStackParams } from "../../App";
import { ConnectionConfig, ControlConn } from "../client";
import { SwiftUI } from "../native-ui";

type Props = NativeStackScreenProps<RootStackParams, "Spawn"> & {
  cfg: ConnectionConfig;
};

interface SpawnFields {
  template: string;
  params: string;
  command: string;
  name: string;
  image: string;
  cwd: string;
}

async function doSpawn(cfg: ConnectionConfig, f: SpawnFields) {
  const parsedParams: Record<string, string> = {};
  for (const line of f.params.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    const eq = t.indexOf("=");
    if (eq < 0) throw new Error(`param wants KEY=VALUE, got '${t}'`);
    parsedParams[t.slice(0, eq)] = t.slice(eq + 1);
  }
  const cmd = f.command.trim() === "" ? null : f.command.trim().split(/\s+/);
  if (f.template.trim() === "" && cmd === null)
    throw new Error("template or command required");
  const conn = await ControlConn.open(cfg);
  try {
    return await conn.spawn({
      template: f.template.trim() || null,
      params: parsedParams,
      name: f.name.trim() || null,
      cmd,
      cwd: f.cwd.trim() || null,
      env: null,
      image: f.image.trim() || null,
      rows: 24,
      cols: 80,
    });
  } finally {
    conn.close();
  }
}

export function SpawnScreen(props: Props) {
  return SwiftUI ? <NativeSpawn {...props} /> : <LegacySpawn {...props} />;
}

/** Mirrors the CLI: `landline spawn TEMPLATE -p k=v` / `landline spawn -- CMD`. */
function NativeSpawn({ navigation, cfg }: Props) {
  const ui = SwiftUI!;
  const fields = useRef<SpawnFields>({
    template: "",
    params: "",
    command: "",
    name: "",
    image: "",
    cwd: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const spawn = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const info = await doSpawn(cfg, fields.current);
      navigation.replace("Terminal", { session: info.id });
    } catch (e: any) {
      setError(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof SpawnFields, placeholder: string, multiline = false) => (
    <ui.TextField
      placeholder={placeholder}
      onTextChange={(t) => (fields.current[key] = t)}
      axis={multiline ? "vertical" : "horizontal"}
    />
  );

  return (
    <ui.Host style={{ flex: 1 }} useViewportSizeMeasurement colorScheme="dark">
      <ui.Form>
        <ui.Section title="Template">
          {field("template", "template name, e.g. webapp-fix")}
          {field("params", "params, KEY=VALUE per line", true)}
        </ui.Section>
        <ui.Section title="Command (instead of / over template)">
          {field("command", "claude")}
        </ui.Section>
        <ui.Section title="Options">
          {field("name", "session name")}
          {field("image", "container image, e.g. ubuntu:24.04")}
          {field("cwd", "working directory")}
        </ui.Section>
        {error !== "" && (
          <ui.Section title="Error">
            <ui.Text>{error}</ui.Text>
          </ui.Section>
        )}
        <ui.Section>
          <ui.Button
            label={busy ? "Spawning…" : "Spawn"}
            systemImage="plus.circle"
            onPress={spawn}
          />
        </ui.Section>
      </ui.Form>
    </ui.Host>
  );
}

function LegacySpawn({ navigation, cfg }: Props) {
  const [f, setF] = useState<SpawnFields>({
    template: "",
    params: "",
    command: "",
    name: "",
    image: "",
    cwd: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const spawn = async () => {
    setBusy(true);
    setError("");
    try {
      const info = await doSpawn(cfg, f);
      navigation.replace("Terminal", { session: info.id });
    } catch (e: any) {
      setError(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const field = (
    key: keyof SpawnFields,
    label: string,
    placeholder: string,
    multiline = false,
  ) => (
    <View key={key}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.multiline]}
        value={f[key]}
        onChangeText={(t) => setF({ ...f, [key]: t })}
        placeholder={placeholder}
        placeholderTextColor="#484f58"
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
      />
    </View>
  );

  return (
    <ScrollView style={styles.root} keyboardShouldPersistTaps="handled">
      {field("template", "template", "webapp-fix (optional)")}
      {field("params", "params (KEY=VALUE per line)", "branch=main", true)}
      {field("command", "command (instead of / over template)", "claude")}
      {field("name", "name", "fix-login (optional)")}
      {field("image", "container image", "ubuntu:24.04 (optional)")}
      {field("cwd", "working directory", "/home/me/project (optional)")}
      {error !== "" && <Text style={styles.error}>{error}</Text>}
      <Pressable style={styles.button} onPress={spawn} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>spawn</Text>}
      </Pressable>
      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0d1117", padding: 16 },
  label: { color: "#8b949e", fontSize: 12, marginBottom: 4 },
  input: {
    backgroundColor: "#161b22",
    color: "#c9d1d9",
    borderRadius: 8,
    padding: 12,
    marginBottom: 14,
    fontFamily: "monospace",
  },
  multiline: { minHeight: 64, textAlignVertical: "top" },
  error: { color: "#f85149", marginBottom: 12 },
  button: {
    backgroundColor: "#238636",
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
  },
  buttonText: { color: "#fff", fontWeight: "600" },
});
