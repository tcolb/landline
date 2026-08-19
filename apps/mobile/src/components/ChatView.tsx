// Chat view of a hybrid session: the daemon's semantic message log.
// Same session, same process as the terminal view — input sent here types
// into the PTY.
//
// Composer architecture (learned the hard way):
// - The composer is ONE SwiftUI subtree (glass + field + send) hosted with
//   matchContents, so its size comes from SwiftUI itself. No RN overlay on
//   a separately-sized glass rectangle, no onLayout feedback loops.
// - It follows the keyboard via an animated BOTTOM offset, never a
//   transform: Liquid Glass is a backdrop material and CALayer transforms
//   invalidate its sampling (the "bubble disappears" failure). A position
//   change relayouts only this small subtree, so it stays glued to the
//   keyboard's top edge without touching the list.
// - The list is a static absolute-fill; keyboard transitions change only
//   its content padding (one relayout per transition, never per frame).

import { LegendList, LegendListRef } from "@legendapp/list/react-native";
import React, { useEffect, useRef, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { AttachHandle, attachChat, ConnectionConfig } from "../client";
import { SwiftUI, SwiftUIModifiers } from "../native-ui";
import { ChatItem, inputMessage } from "../proto";
import { useSessions } from "../sessions";

interface Props {
  cfg: ConnectionConfig;
  session: string;
}

/** Reanimated, guarded (null on binaries without it). */
const anim = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const r = require("react-native-reanimated");
    if (!r.useAnimatedKeyboard || !r.default) return null;
    return {
      Animated: r.default,
      useAnimatedKeyboard: r.useAnimatedKeyboard,
      useAnimatedStyle: r.useAnimatedStyle,
    };
  } catch {
    return null;
  }
})();

const nativeComposer = SwiftUI !== null && SwiftUIModifiers !== null && anim !== null;

/** The whole composer as a single SwiftUI subtree: glass panel containing
 * the multiline field and the send circle. Sizes itself (matchContents);
 * grows with text. */
function NativeComposer({
  agentName,
  onSend,
}: {
  agentName: string;
  onSend(text: string): void;
}) {
  const S = SwiftUI!;
  const m = SwiftUIModifiers!;
  const draft = useRef("");
  const field = useRef<import("@expo/ui/swift-ui").TextFieldRef>(null);
  const send = () => {
    const text = draft.current.trim();
    if (text === "") return;
    onSend(text);
    draft.current = "";
    field.current?.clear();
  };
  return (
    <S.Host style={styles.nativeHost} colorScheme="dark" matchContents={{ vertical: true }}>
      <S.VStack
        spacing={2}
        modifiers={[
          m.padding({ top: 6, bottom: 6, leading: 4, trailing: 6 }),
          m.glassEffect({
            glass: { variant: "regular" },
            shape: "roundedRectangle",
            cornerRadius: 26,
          }),
        ]}
      >
        <S.TextField
          ref={field}
          axis="vertical"
          placeholder={`Ask ${agentName}`}
          onTextChange={(t) => {
            draft.current = t;
          }}
          modifiers={[
            m.font({ size: 17 }),
            m.lineLimit(5),
            m.padding({ leading: 12, trailing: 8, top: 6 }),
            m.textFieldStyle("plain"),
          ]}
        />
        <S.HStack>
          <S.Spacer />
          <S.Button
            onPress={send}
            modifiers={[
              m.buttonStyle("glassProminent"),
              m.buttonBorderShape("circle"),
              m.tint("#238636"),
            ]}
          >
            <S.Image
              systemName="arrow.up"
              size={14}
              color="#ffffff"
              modifiers={[m.frame({ width: 18, height: 18 })]}
            />
          </S.Button>
        </S.HStack>
      </S.VStack>
    </S.Host>
  );
}

/** Positions the composer above the keyboard by animating its bottom
 * offset on the UI thread (position, never transform — see header). */
function KeyboardDocked({ children }: { children: React.ReactNode }) {
  const a = anim!;
  const kb = a.useAnimatedKeyboard();
  const style = a.useAnimatedStyle(() => ({
    bottom: kb.height.value,
  }));
  const A = a.Animated.View;
  return <A style={[styles.dock, style]}>{children}</A>;
}

export function ChatView({ cfg, session }: Props) {
  const sessions = useSessions(cfg);
  // The agent's identity is its command ("claude" -> "Claude"), never the
  // session id.
  const agentCmd = sessions.data?.find((s) => s.id === session)?.cmd?.[0] ?? "";
  const agentBase = agentCmd.split("/").pop() ?? "";
  const agentName =
    agentBase === "" ? "agent" : agentBase.charAt(0).toUpperCase() + agentBase.slice(1);

  const [items, setItems] = useState<ChatItem[]>([]);
  const [status, setStatus] = useState("connecting…");
  const [draft, setDraft] = useState("");
  const [kbClearance, setKbClearance] = useState(0);
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

  // One relayout per keyboard transition: pad the list clear of the lifted
  // composer.
  useEffect(() => {
    if (Platform.OS !== "ios" || !nativeComposer) return;
    const show = Keyboard.addListener("keyboardWillShow", (e) => {
      setKbClearance(e.endCoordinates.height);
      requestAnimationFrame(() => list.current?.scrollToEnd({ animated: true }));
    });
    const hide = Keyboard.addListener("keyboardWillHide", () => setKbClearance(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const sendText = (text: string) => {
    if (handle.current === null) return;
    // Types into the same PTY the terminal shows: text, then Enter.
    handle.current.send(inputMessage(text));
    setTimeout(() => handle.current?.send(inputMessage("\r")), 120);
  };

  const sendDraft = () => {
    const text = draft.trim();
    if (text === "") return;
    sendText(text);
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
    // Genre convention: only the user's messages sit in a bubble; the
    // agent's prose flows as full-width text blocks.
    if (item.role === "user") {
      return (
        <View style={[styles.bubble, styles.userBubble]}>
          <Text style={styles.userText}>{item.text}</Text>
        </View>
      );
    }
    return (
      <View style={styles.assistantBlock}>
        <Text style={styles.assistantText}>{item.text}</Text>
      </View>
    );
  };

  const messageList = (
    <LegendList
      ref={list}
      data={items}
      keyExtractor={(i: ChatItem) => String(i.id)}
      renderItem={renderItem}
      estimatedItemSize={64}
      recycleItems
      contentContainerStyle={{ paddingBottom: kbClearance + 120 }}
      ListEmptyComponent={
        <Text style={styles.empty}>
          {status === "" ? "no messages yet — say something" : ""}
        </Text>
      }
    />
  );

  if (nativeComposer) {
    return (
      <View style={styles.root}>
        <View style={StyleSheet.absoluteFill}>{messageList}</View>
        {status !== "" && <Text style={styles.status}>{status}</Text>}
        <KeyboardDocked>
          <NativeComposer agentName={agentName} onSend={sendText} />
        </KeyboardDocked>
      </View>
    );
  }

  // Fallback (Android / pre-module binaries): plain RN composer.
  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {status !== "" && <Text style={styles.status}>{status}</Text>}
      {messageList}
      <View style={styles.fallbackRow}>
        <TextInput
          style={styles.fallbackInput}
          value={draft}
          onChangeText={setDraft}
          placeholder={`Ask ${agentName}`}
          placeholderTextColor="#8b949e"
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
  userText: { color: "#fff", fontSize: 16, lineHeight: 22 },
  assistantBlock: {
    alignSelf: "stretch",
    marginHorizontal: 16,
    marginVertical: 6,
  },
  assistantText: { color: "#c9d1d9", fontSize: 16, lineHeight: 24 },
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
  // Composer dock: absolute strip pinned above the keyboard by an animated
  // bottom offset.
  dock: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 0,
    paddingBottom: 10,
  },
  nativeHost: { width: "100%" },
  // Fallback composer.
  fallbackRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  fallbackInput: {
    flex: 1,
    color: "#c9d1d9",
    backgroundColor: "#141414",
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 12,
    maxHeight: 120,
    fontSize: 17,
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
