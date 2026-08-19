// Agent-first spawn (docs/DESIGN.md): templates are the primary surface —
// pick an agent preset, fill its parameters, go. Inline command / image /
// cwd live behind Advanced as the escape hatch.

import { NativeStackScreenProps } from "@react-navigation/native-stack";
import React, { useEffect, useRef, useState } from "react";
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
import { EnvironmentInfo, TemplateInfo } from "../proto";
import { useEnvironments, useTemplates } from "../sessions";

type Props = NativeStackScreenProps<RootStackParams, "Spawn"> & {
  cfg: ConnectionConfig;
  /** Drawer layout: handle the spawned session instead of stack navigation. */
  onSpawned?(info: import("../proto").SessionInfo): void;
};

interface Advanced {
  command: string;
  name: string;
  image: string;
  cwd: string;
}

async function doSpawn(
  cfg: ConnectionConfig,
  template: string | null,
  params: Record<string, string>,
  env: string | null,
  adv: Advanced,
) {
  const cmd = adv.command.trim() === "" ? null : adv.command.trim().split(/\s+/);
  if (template === null && cmd === null)
    throw new Error("pick a template (or set a command under Advanced)");
  const cleanParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v.trim() !== "") cleanParams[k] = v;
  }
  const conn = await ControlConn.open(cfg);
  try {
    return await conn.spawn({
      template,
      params: cleanParams,
      name: adv.name.trim() || null,
      cmd,
      cwd: adv.cwd.trim() || null,
      env,
      image: adv.image.trim() || null,
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

function NativeSpawn({ navigation, cfg, onSpawned }: Props) {
  const ui = SwiftUI!;
  const templates = useTemplates(cfg);
  const environments = useEnvironments(cfg);
  const [selected, setSelected] = useState<TemplateInfo | null>(null);
  /** null = the template's own environment (agent × environment: the
   * second dimension is overridable, defaulted from the agent). */
  const [envOverride, setEnvOverride] = useState<string | null>(null);
  const params = useRef<Record<string, string>>({});
  const adv = useRef<Advanced>({ command: "", name: "", image: "", cwd: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Agent-first: preselect the first template as soon as the list loads.
  useEffect(() => {
    if (selected === null && (templates.data?.length ?? 0) > 0) {
      setSelected(templates.data![0]);
    }
  }, [templates.data, selected]);

  const pick = (t: TemplateInfo) => {
    setSelected(t);
    params.current = {};
  };

  const spawn = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const info = await doSpawn(
        cfg,
        selected?.name ?? null,
        params.current,
        envOverride,
        adv.current,
      );
      if (onSpawned) onSpawned(info);
      else navigation.replace("Terminal", { session: info.id, chat: info.chat === true });
    } catch (e: any) {
      setError(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ui.Host style={{ flex: 1 }} useViewportSizeMeasurement colorScheme="dark">
      <ui.Form>
        <ui.Section title="Agent">
          {templates.isLoading && <ui.Text>Loading templates…</ui.Text>}
          {templates.error != null && (
            <ui.Text>{`templates: ${String((templates.error as Error).message)}`}</ui.Text>
          )}
          {(templates.data ?? []).map((t) => (
            <ui.Button key={t.name} onPress={() => pick(t)}>
              <ui.HStack spacing={10}>
                <ui.Image
                  systemName={
                    selected?.name === t.name ? "checkmark.circle.fill" : "circle"
                  }
                />
                <ui.VStack alignment="leading" spacing={2}>
                  <ui.Text>{t.name}</ui.Text>
                  <ui.Text>{t.description ?? `${t.command} · ${t.environment}`}</ui.Text>
                </ui.VStack>
                <ui.Spacer />
              </ui.HStack>
            </ui.Button>
          ))}
          {templates.data?.length === 0 && (
            <ui.Text>
              No templates yet — add TOML files under ~/.config/landline/templates/ on
              the daemon host.
            </ui.Text>
          )}
        </ui.Section>
        {selected !== null && selected.params.length > 0 && (
          <ui.Section title={`${selected.name} parameters`}>
            {selected.params.map((p) => (
              <ui.TextField
                key={`${selected.name}.${p.name}`}
                placeholder={
                  p.required ? `${p.name} (required)` : `${p.name} — ${p.default ?? ""}`
                }
                onTextChange={(t) => (params.current[p.name] = t)}
              />
            ))}
          </ui.Section>
        )}
        <ui.Section title="Environment">
          <ui.Button onPress={() => setEnvOverride(null)}>
            <ui.HStack spacing={10}>
              <ui.Image
                systemName={envOverride === null ? "checkmark.circle.fill" : "circle"}
              />
              <ui.Text>{`Template default${selected ? ` (${selected.environment})` : ""}`}</ui.Text>
              <ui.Spacer />
            </ui.HStack>
          </ui.Button>
          {(environments.data ?? []).map((e: EnvironmentInfo) => (
            <ui.Button key={e.name} onPress={() => setEnvOverride(e.name)}>
              <ui.HStack spacing={10}>
                <ui.Image
                  systemName={envOverride === e.name ? "checkmark.circle.fill" : "circle"}
                />
                <ui.VStack alignment="leading" spacing={2}>
                  <ui.Text>{e.name + (e.image ? ` · ${e.image}` : "")}</ui.Text>
                  {e.description != null && <ui.Text>{e.description}</ui.Text>}
                </ui.VStack>
                <ui.Spacer />
              </ui.HStack>
            </ui.Button>
          ))}
        </ui.Section>
        <ui.DisclosureGroup label="Advanced">
          <ui.TextField
            placeholder="inline command (overrides template)"
            onTextChange={(t) => (adv.current.command = t)}
          />
          <ui.TextField
            placeholder="session name"
            onTextChange={(t) => (adv.current.name = t)}
          />
          <ui.TextField
            placeholder="container image"
            onTextChange={(t) => (adv.current.image = t)}
          />
          <ui.TextField
            placeholder="working directory"
            onTextChange={(t) => (adv.current.cwd = t)}
          />
        </ui.DisclosureGroup>
        {error !== "" && (
          <ui.Section title="Error">
            <ui.Text>{error}</ui.Text>
          </ui.Section>
        )}
        <ui.Section>
          <ui.Button
            label={busy ? "Spawning…" : selected ? `Spawn ${selected.name}` : "Spawn"}
            systemImage="plus.circle"
            onPress={spawn}
          />
        </ui.Section>
      </ui.Form>
    </ui.Host>
  );
}

function LegacySpawn({ navigation, cfg, onSpawned }: Props) {
  const templates = useTemplates(cfg);
  const environments = useEnvironments(cfg);
  const [selected, setSelected] = useState<TemplateInfo | null>(null);
  const [envOverride, setEnvOverride] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});
  const [adv, setAdv] = useState<Advanced>({ command: "", name: "", image: "", cwd: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (selected === null && (templates.data?.length ?? 0) > 0) {
      setSelected(templates.data![0]);
    }
  }, [templates.data, selected]);

  const spawn = async () => {
    setBusy(true);
    setError("");
    try {
      const info = await doSpawn(cfg, selected?.name ?? null, params, envOverride, adv);
      if (onSpawned) onSpawned(info);
      else navigation.replace("Terminal", { session: info.id, chat: info.chat === true });
    } catch (e: any) {
      setError(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.root} keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>agent template</Text>
      <View style={styles.chips}>
        {(templates.data ?? []).map((t) => (
          <Pressable
            key={t.name}
            style={[styles.chip, selected?.name === t.name && styles.chipActive]}
            onPress={() => {
              setSelected(t);
              setParams({});
            }}
          >
            <Text style={styles.chipText}>{t.name}</Text>
          </Pressable>
        ))}
      </View>
      {selected?.params.map((p) => (
        <View key={`${selected.name}.${p.name}`}>
          <Text style={styles.label}>
            {p.name}
            {p.required ? " (required)" : p.default ? ` — default ${p.default}` : ""}
          </Text>
          <TextInput
            style={styles.input}
            value={params[p.name] ?? ""}
            onChangeText={(t) => setParams({ ...params, [p.name]: t })}
            placeholderTextColor="#484f58"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      ))}
      <Text style={styles.label}>environment</Text>
      <View style={styles.chips}>
        <Pressable
          style={[styles.chip, envOverride === null && styles.chipActive]}
          onPress={() => setEnvOverride(null)}
        >
          <Text style={styles.chipText}>template default</Text>
        </Pressable>
        {(environments.data ?? []).map((e: EnvironmentInfo) => (
          <Pressable
            key={e.name}
            style={[styles.chip, envOverride === e.name && styles.chipActive]}
            onPress={() => setEnvOverride(e.name)}
          >
            <Text style={styles.chipText}>{e.name}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.label}>advanced: command / name / image / cwd</Text>
      {(["command", "name", "image", "cwd"] as (keyof Advanced)[]).map((k) => (
        <TextInput
          key={k}
          style={styles.input}
          value={adv[k]}
          onChangeText={(t) => setAdv({ ...adv, [k]: t })}
          placeholder={k}
          placeholderTextColor="#484f58"
          autoCapitalize="none"
          autoCorrect={false}
        />
      ))}
      {error !== "" && <Text style={styles.error}>{error}</Text>}
      <Pressable style={styles.button} onPress={spawn} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>spawn</Text>}
      </Pressable>
      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000000", padding: 16 },
  label: { color: "#8b949e", fontSize: 12, marginBottom: 4, marginTop: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    backgroundColor: "#1e1e1e",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipActive: { backgroundColor: "#238636" },
  chipText: { color: "#c9d1d9", fontSize: 13 },
  input: {
    backgroundColor: "#141414",
    color: "#c9d1d9",
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
    fontFamily: "monospace",
  },
  error: { color: "#f85149", marginVertical: 12 },
  button: {
    backgroundColor: "#238636",
    borderRadius: 8,
    padding: 14,
    alignItems: "center",
    marginTop: 12,
  },
  buttonText: { color: "#fff", fontWeight: "600" },
});
