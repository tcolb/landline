// Chat view of a hybrid session: the daemon's semantic message log
// rendered as bubbles. Same session, same process as the terminal view —
// input sent here types into the PTY.

import { LegendList, LegendListRef } from "@legendapp/list/react-native";
import React, { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { AttachHandle, attachChat, ConnectionConfig } from "../client";
import { ChatItem, inputMessage } from "../proto";

interface Props {
  cfg: ConnectionConfig;
  session: string;
}

export function ChatView({ cfg, session }: Props) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [status, setStatus] = useState("connecting…");
  const [draft, setDraft] = useState("");
  const handle = useRef<AttachHandle | null>(null);
  const list = useRef<LegendListRef>(null);

  useEffect(() => {
    let alive = true;
    let h: AttachHandle | null = null;
    attachChat(cfg, session, {
      snapshot: (snap) => alive && setItems(snap),
      item: (item) =>
        alive &&
        setItems((prev) =>
          prev.some((p) => p.id === item.id) ? prev : [...prev, item],
        ),
      exited: (code) => alive && setStatus(`exited(${code ?? "?"})`),
      error: (m) => alive && setStatus(m),
      closed: () => alive && setStatus((s) => (s.startsWith("exited") ? s : "disconnected")),
    })
      .then((got) => {
        if (!alive) return got.detach();
        h = got;
        handle.current = got;
        setStatus("");
      })
      .catch((e) => alive && setStatus(String(e.message ?? e)));
    return () => {
      alive = false;
      h?.detach();
      handle.current = null;
    };
  }, [cfg, session]);

  useEffect(() => {
    if (items.length > 0) {
      requestAnimationFrame(() => list.current?.scrollToEnd({ animated: true }));
    }
  }, [items.length]);

  const sendDraft = () => {
    const text = draft.trim();
    if (text === "" || handle.current === null) return;
    // Types into the same PTY the terminal shows: text, then Enter.
    handle.current.send(inputMessage(text));
    setTimeout(() => handle.current?.send(inputMessage("\r")), 120);
    setDraft("");
  };

  const renderItem = ({ item }: { item: ChatItem }) => {
    if (item.kind === "tool_use") {
      return (
        <View style={styles.toolRow}>
          <Text style={styles.toolTitle}>⚒ {item.tool ?? "tool"}</Text>
          <Text style={styles.toolText} numberOfLines={6}>
            {item.text}
          </Text>
        </View>
      );
    }
    if (item.kind === "tool_result") {
      return (
        <View style={styles.toolRow}>
          <Text style={styles.toolText} numberOfLines={8}>
            {item.text}
          </Text>
        </View>
      );
    }
    const user = item.role === "user";
    return (
      <View style={[styles.bubble, user ? styles.userBubble : styles.assistantBubble]}>
        <Text style={user ? styles.userText : styles.assistantText}>{item.text}</Text>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {status !== "" && <Text style={styles.status}>{status}</Text>}
      <LegendList
        ref={list}
        data={items}
        keyExtractor={(i: ChatItem) => String(i.id)}
        renderItem={renderItem}
        estimatedItemSize={64}
        recycleItems
        ListEmptyComponent={
          <Text style={styles.empty}>
            {status === "" ? "no messages yet — say something" : ""}
          </Text>
        }
      />
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message the agent…"
          placeholderTextColor="#484f58"
          multiline
          autoCapitalize="none"
          autoCorrect
        />
        <Pressable style={styles.sendBtn} onPress={sendDraft}>
          <Text style={styles.sendText}>↑</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000000" },
  status: { color: "#8b949e", fontSize: 12, textAlign: "center", padding: 4 },
  empty: { color: "#484f58", textAlign: "center", marginTop: 48 },
  bubble: {
    maxWidth: "85%",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginHorizontal: 12,
    marginVertical: 4,
  },
  userBubble: { alignSelf: "flex-end", backgroundColor: "#238636" },
  assistantBubble: { alignSelf: "flex-start", backgroundColor: "#1e1e1e" },
  userText: { color: "#fff", fontSize: 15 },
  assistantText: { color: "#c9d1d9", fontSize: 15 },
  toolRow: {
    alignSelf: "stretch",
    backgroundColor: "#141414",
    borderLeftWidth: 2,
    borderLeftColor: "#2a2a2a",
    marginHorizontal: 12,
    marginVertical: 3,
    padding: 8,
    borderRadius: 6,
  },
  toolTitle: { color: "#8b949e", fontSize: 12, fontWeight: "600", marginBottom: 2 },
  toolText: { color: "#8b949e", fontFamily: "monospace", fontSize: 11 },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 8,
    gap: 8,
    backgroundColor: "#141414",
  },
  input: {
    flex: 1,
    color: "#c9d1d9",
    backgroundColor: "#000000",
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 9,
    maxHeight: 120,
    fontSize: 15,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#238636",
    alignItems: "center",
    justifyContent: "center",
  },
  sendText: { color: "#fff", fontSize: 18, fontWeight: "700" },
});
