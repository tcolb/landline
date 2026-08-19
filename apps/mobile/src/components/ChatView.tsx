// Chat view of a hybrid session: the daemon's semantic message log
// rendered as bubbles. Same session, same process as the terminal view —
// input sent here types into the PTY.

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
import { IconButton } from "./IconButton";
import { SwiftUI, SwiftUIModifiers } from "../native-ui";
import { ChatItem, inputMessage } from "../proto";
import { useSessions } from "../sessions";

/** Frame-synced keyboard avoidance (reanimated tracks the real keyboard
 * transition on the UI thread); KAV fallback on old binaries. */
const kbKit = (() => {
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

/** Lifts the composer with a pure transform tracking the keyboard's top
 * edge on the UI thread — no per-frame layout, so the motion is glued to
 * the keyboard and the bubble's internals never reflow. */
function ComposerLift({ children }: { children: React.ReactNode }) {
  const k = kbKit!;
  const kb = k.useAnimatedKeyboard();
  const style = k.useAnimatedStyle(() => ({
    transform: [{ translateY: -kb.height.value }],
  }));
  const A = k.Animated.View;
  return <A style={style}>{children}</A>;
}

function ComposerLiftMaybe({ children }: { children: React.ReactNode }) {
  if (kbKit !== null) return <ComposerLift>{children}</ComposerLift>;
  return <>{children}</>;
}

function KbAvoiding({ children }: { children: React.ReactNode }) {
  // With reanimated the lift is handled per-component; plain container here.
  if (kbKit !== null) return <View style={styles.root}>{children}</View>;
  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {children}
    </KeyboardAvoidingView>
  );
}

interface Props {
  cfg: ConnectionConfig;
  session: string;
}

export function ChatView({ cfg, session }: Props) {
  const sessions = useSessions(cfg);
  // The agent's identity is its command ("claude" -> "Claude"), never the
  // session id.
  const agentCmd = sessions.data?.find((s) => s.id === session)?.cmd?.[0] ?? "";
  const agentBase = agentCmd.split("/").pop() ?? "";
  const agentName =
    agentBase === "" ? "agent" : agentBase.charAt(0).toUpperCase() + agentBase.slice(1);
  // List clearance under the lifted composer: single relayout per keyboard
  // transition (not per-frame), content just scrolls up behind it.
  const [kbClearance, setKbClearance] = useState(0);
  // Measured bubble size for the glass layer: an explicit host frame keeps
  // SwiftUI's drawing exactly bubble-sized (viewport measurement proposes
  // the whole screen, and hosting views do not clip).
  const [bubbleSize, setBubbleSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (Platform.OS !== "ios" || kbKit === null) return;
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

  return (
    <KbAvoiding>
      {status !== "" && <Text style={styles.status}>{status}</Text>}
      <LegendList
        ref={list}
        data={items}
        keyExtractor={(i: ChatItem) => String(i.id)}
        renderItem={renderItem}
        estimatedItemSize={64}
        recycleItems
        contentContainerStyle={{ paddingBottom: kbClearance }}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {status === "" ? "no messages yet — say something" : ""}
          </Text>
        }
      />
      <ComposerLiftMaybe>
      <View style={styles.inputRow}>
        <View
          style={[styles.bubbleWrap, SwiftUI === null && styles.bubbleFallback]}
          onLayout={(e) =>
            setBubbleSize({
              w: e.nativeEvent.layout.width,
              h: e.nativeEvent.layout.height,
            })
          }
        >
          {SwiftUI !== null && SwiftUIModifiers !== null && bubbleSize.w > 0 && (
            // Liquid Glass panel behind the transparent field, sized to the
            // measured bubble.
            <SwiftUI.Host
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: bubbleSize.w,
                height: bubbleSize.h,
              }}
              colorScheme="dark"
              pointerEvents="none"
            >
              <SwiftUI.HStack
                modifiers={[
                  SwiftUIModifiers.frame({ maxWidth: 9999, maxHeight: 9999 }),
                  SwiftUIModifiers.glassEffect({
                    glass: { variant: "regular" },
                    shape: "roundedRectangle",
                    cornerRadius: 26,
                  }),
                ]}
              >
                <SwiftUI.Spacer />
              </SwiftUI.HStack>
            </SwiftUI.Host>
          )}
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={`Ask ${agentName}`}
            placeholderTextColor="#8b949e"
            multiline
            autoCapitalize="none"
            autoCorrect
          />
          <View style={styles.sendRow}>
            {SwiftUI !== null ? (
              <IconButton symbol="arrow.up" fallback="↑" onPress={sendDraft} accent size={34} />
            ) : (
              <Pressable style={styles.sendBtn} onPress={sendDraft}>
                <Text style={styles.sendText}>↑</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>
      </ComposerLiftMaybe>
    </KbAvoiding>
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
  // Floating composer: no bar background — the glass capsule and glass
  // send circle hover over the conversation.
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    backgroundColor: "transparent",
  },
  // Full-width floating bubble: input row on top, send circle bottom-right.
  bubbleWrap: {
    flex: 1,
    minHeight: 80,
    paddingBottom: 8,
  },
  bubbleFallback: { backgroundColor: "#141414", borderRadius: 26, overflow: "hidden" },
  input: {
    color: "#c9d1d9",
    backgroundColor: "transparent",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
    maxHeight: 120,
    fontSize: 17,
    lineHeight: 22,
  },
  sendRow: { flexDirection: "row", justifyContent: "flex-end", paddingRight: 8 },
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
