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
import { kbc } from "../kb-native";
import { onDismissAllKeyboards } from "../kb";
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
      useSharedValue: r.useSharedValue,
    };
  } catch {
    return null;
  }
})();

const nativeComposer = SwiftUI !== null && SwiftUIModifiers !== null && anim !== null;

/** The whole composer as a single SwiftUI subtree: glass panel containing
 * the multiline field and the send circle. Sizes itself (matchContents);
 * grows with text. */
/** Bubble geometry. RN owns ALL of it: the input's content height (via
 * onContentSizeChange) drives the bubble height in the same RN commit that
 * resizes the glass host (absoluteFill) — one framework, one layout pass,
 * no cross-framework seam frames. SwiftUI is decoration only: the glass
 * fill and the fixed-size send circle, neither of which is ever measured.
 * Send seat is concentric by construction: gap = R - D/2. */
const BUBBLE_RADIUS = 26;
const SEND_DIAMETER = 36;
const SEND_GAP = BUBBLE_RADIUS - SEND_DIAMETER / 2;
const INPUT_LINE = 24;
const INPUT_MAX_LINES = 5;
const INPUT_PAD_TOP = 12;
const INPUT_PAD_BOTTOM = SEND_DIAMETER + SEND_GAP + 4;

function NativeComposer({
  agentName,
  onSend,
}: {
  agentName: string;
  onSend(text: string): void;
}) {
  const S = SwiftUI!;
  const m = SwiftUIModifiers!;
  const [draft, setDraft] = useState("");
  const [contentH, setContentH] = useState(INPUT_LINE);
  const input = useRef<TextInput>(null);
  // iOS multiline inputs fire spurious onContentSizeChange on blur/keyboard
  // dismissal; the bubble must NEVER resize except while actively editing.
  const editing = useRef(false);
  // Fabric's onContentSizeChange is unreliable — a hidden Text twin with
  // identical metrics measures the draft instead.
  const onMeasure = (h: number) => {
    if (editing.current) setContentH(Math.ceil(h));
  };
  const send = () => {
    const text = draft.trim();
    if (text === "") return;
    onSend(text);
    setDraft("");
    setContentH(INPUT_LINE);
  };
  // Swipe-away (or any app-wide dismissal): blur the field. RN tracks this
  // input, so Keyboard.dismiss() also works — the bus blur is belt and
  // braces.
  useEffect(() => onDismissAllKeyboards(() => input.current?.blur()), []);

  const inputH = Math.min(INPUT_MAX_LINES * INPUT_LINE, Math.max(INPUT_LINE, contentH));
  const bubbleH = INPUT_PAD_TOP + inputH + INPUT_PAD_BOTTOM;
  return (
    <View style={{ height: bubbleH }}>
      {/* ignoreSafeArea: hosting views apply the KEYBOARD safe area to
          their SwiftUI content by default — iOS itself was insetting and
          re-animating the glass during keyboard transitions. */}
      <S.Host
        style={StyleSheet.absoluteFill}
        colorScheme="dark"
        pointerEvents="none"
        ignoreSafeArea="all"
      >
        <S.HStack
          modifiers={[
            m.frame({ maxWidth: 9999, maxHeight: 9999 }),
            m.glassEffect({
              glass: { variant: "regular" },
              shape: "roundedRectangle",
              cornerRadius: BUBBLE_RADIUS,
            }),
          ]}
        >
          <S.Spacer />
        </S.HStack>
      </S.Host>
      <TextInput
        ref={input}
        style={[styles.nativeInput, { height: inputH }]}
        value={draft}
        onChangeText={(t) => {
          setDraft(t);
          // Newline growth is deterministic — commit it in the SAME frame
          // as the text. Waiting for the async measurer leaves a lag frame
          // in which UITextView scrolls the caret into view, permanently
          // shifting the content up a row.
          const minH = ((t.match(/\n/g)?.length ?? 0) + 1) * INPUT_LINE;
          if (minH > contentH && editing.current) setContentH(minH);
        }}
        onFocus={() => {
          editing.current = true;
        }}
        onBlur={() => {
          editing.current = false;
        }}
        placeholder={`Ask ${agentName}`}
        placeholderTextColor="#8b949e"
        multiline
        scrollEnabled={contentH > INPUT_MAX_LINES * INPUT_LINE}
        autoCapitalize="none"
        autoCorrect
      />
      {/* Invisible measurer: same font, line height, and wrap width as the
          input (UITextView adds 5pt line-fragment padding per side, mirrored
          here) — its layout height is the input's content height. */}
      <Text
        style={styles.measurer}
        pointerEvents="none"
        onLayout={(e) => onMeasure(e.nativeEvent.layout.height)}
      >
        {draft.length > 0 ? draft + "\u200b" : "X"}
      </Text>
      <View style={styles.sendSeat}>
        <S.Host
          style={{ width: SEND_DIAMETER, height: SEND_DIAMETER }}
          colorScheme="dark"
          ignoreSafeArea="all"
        >
          <S.Image
            systemName="arrow.up"
            size={16}
            color="#ffffff"
            onPress={send}
            modifiers={[
              m.frame({ width: SEND_DIAMETER, height: SEND_DIAMETER }),
              m.glassEffect({
                glass: { variant: "regular", interactive: true, tint: "#238636" },
                shape: "circle",
              }),
            ]}
          />
        </S.Host>
      </View>
    </View>
  );
}

/** Positions the composer above the keyboard by animating its bottom
 * offset on the UI thread (position, never transform — see header).
 * Driver preference: keyboard-controller's native projections (exact
 * system curve) when the binary has it; reanimated's tracker otherwise. */
function DockedByController({ children }: { children: React.ReactNode }) {
  const a = anim!;
  const h = a.useSharedValue!(0);
  kbc!.useKeyboardHandler(
    {
      onMove: (e) => {
        "worklet";
        h.value = e.height;
      },
      onInteractive: (e) => {
        "worklet";
        h.value = e.height;
      },
      onEnd: (e) => {
        "worklet";
        h.value = e.height;
      },
    },
    [],
  );
  // Clamp: the system curve can overshoot below zero at the end of a
  // dismissal, which would drag the dock past the screen edge.
  const style = a.useAnimatedStyle(() => ({ bottom: Math.max(0, h.value) }));
  const A = a.Animated.View;
  return <A style={[styles.dock, style]}>{children}</A>;
}

function DockedByReanimated({ children }: { children: React.ReactNode }) {
  const a = anim!;
  const kb = a.useAnimatedKeyboard();
  const style = a.useAnimatedStyle(() => ({
    bottom: Math.max(0, kb.height.value),
  }));
  const A = a.Animated.View;
  return <A style={[styles.dock, style]}>{children}</A>;
}

function KeyboardDocked({ children }: { children: React.ReactNode }) {
  if (kbc !== null && anim?.useSharedValue) {
    return <DockedByController>{children}</DockedByController>;
  }
  return <DockedByReanimated>{children}</DockedByReanimated>;
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
  // Genre look (ChatGPT/Claude): user text in a neutral dark block with a
  // modest, even corner radius — not the iOS-Messages pill.
  bubble: {
    maxWidth: "85%",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginHorizontal: 12,
    marginVertical: 4,
  },
  userBubble: { alignSelf: "flex-end", backgroundColor: "#2a2a2a" },
  userText: { color: "#e6edf3", fontSize: 18, lineHeight: 24 },
  assistantBlock: {
    alignSelf: "stretch",
    marginHorizontal: 16,
    marginVertical: 6,
  },
  assistantText: { color: "#c9d1d9", fontSize: 18, lineHeight: 27 },
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
  nativeInput: {
    position: "absolute",
    top: INPUT_PAD_TOP,
    left: 16,
    right: 16,
    color: "#e6edf3",
    backgroundColor: "transparent",
    fontSize: 18,
    lineHeight: INPUT_LINE,
    paddingTop: 0,
    paddingBottom: 0,
    textAlignVertical: "top",
  },
  measurer: {
    position: "absolute",
    left: 16 + 5,
    right: 16 + 5,
    top: 0,
    opacity: 0,
    fontSize: 18,
    lineHeight: INPUT_LINE,
  },
  sendSeat: { position: "absolute", right: SEND_GAP, bottom: SEND_GAP },
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
