import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ConnectionConfig, ControlConn } from "../client";
import { SessionInfo } from "../proto";

interface Props {
  cfg: ConnectionConfig;
  onSpawned(info: SessionInfo): void;
  onBack(): void;
}

/** Template spawn (name + key=value params) or inline command; mirrors the
 * CLI: `landline spawn TEMPLATE -p k=v` / `landline spawn -- CMD`. */
export function SpawnScreen({ cfg, onSpawned, onBack }: Props) {
  const [template, setTemplate] = useState("");
  const [params, setParams] = useState("");
  const [command, setCommand] = useState("");
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const spawn = async () => {
    setBusy(true);
    setError("");
    try {
      const parsedParams: Record<string, string> = {};
      for (const line of params.split("\n")) {
        const t = line.trim();
        if (t === "") continue;
        const eq = t.indexOf("=");
        if (eq < 0) throw new Error(`param wants KEY=VALUE, got '${t}'`);
        parsedParams[t.slice(0, eq)] = t.slice(eq + 1);
      }
      const cmd = command.trim() === "" ? null : command.trim().split(/\s+/);
      if (template.trim() === "" && cmd === null)
        throw new Error("template or command required");
      const conn = await ControlConn.open(cfg);
      const info = await conn.spawn({
        template: template.trim() || null,
        params: parsedParams,
        name: name.trim() || null,
        cmd,
        cwd: cwd.trim() || null,
        env: null,
        image: image.trim() || null,
        rows: 24,
        cols: 80,
      });
      conn.close();
      onSpawned(info);
    } catch (e: any) {
      setError(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
    placeholder: string,
    multiline = false,
  ) => (
    <View key={label}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.multiline]}
        value={value}
        onChangeText={set}
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
      <View style={styles.header}>
        <Pressable onPress={onBack}>
          <Text style={styles.back}>‹ back</Text>
        </Pressable>
        <Text style={styles.title}>spawn session</Text>
      </View>
      {field("template", template, setTemplate, "webapp-fix (optional)")}
      {field("params (KEY=VALUE per line)", params, setParams, "branch=main", true)}
      {field("command (instead of / over template)", command, setCommand, "claude")}
      {field("name", name, setName, "fix-login (optional)")}
      {field("container image", image, setImage, "ubuntu:24.04 (optional)")}
      {field("working directory", cwd, setCwd, "/home/me/project (optional)")}
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
  header: { flexDirection: "row", alignItems: "center", gap: 16, marginBottom: 16 },
  back: { color: "#58a6ff", fontSize: 16 },
  title: { color: "#c9d1d9", fontSize: 20, fontWeight: "600" },
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
