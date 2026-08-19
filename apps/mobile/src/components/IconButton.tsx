// Circular glass bar button with a real SF Symbol — the iOS 26 top-bar
// control idiom (Liquid Glass pill, symbol glyph). A full SwiftUI Button
// so the glass material and press shimmer are the system's own; falls
// back to a flat circle on Android / pre-module binaries.

import React from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { SwiftUI, SwiftUIModifiers } from "../native-ui";

interface Props {
  /** SF Symbol name, e.g. "line.3.horizontal", "plus". */
  symbol: string;
  /** Fallback glyph when SwiftUI is unavailable. */
  fallback: string;
  onPress(): void;
  size?: number;
  accent?: boolean;
}

// The UINavigationBar standard: 44pt control, 17pt symbol.
const BAR_BUTTON_SIZE = 44;
const BAR_SYMBOL_SIZE = 17;

export function IconButton({ symbol, fallback, onPress, size = BAR_BUTTON_SIZE, accent }: Props) {
  if (SwiftUI !== null && SwiftUIModifiers !== null) {
    const m = SwiftUIModifiers;
    const modifiers = [
      m.buttonStyle(accent ? "glassProminent" : "glass"),
      m.buttonBorderShape("circle"),
      // The glass pill sizes itself from label padding; pin the frame so
      // every bar button lands on the same standard circle.
      m.frame({ width: size, height: size }),
    ];
    if (accent) modifiers.push(m.tint("#238636"));
    return (
      <SwiftUI.Host style={{ width: size, height: size }} colorScheme="dark">
        <SwiftUI.Button onPress={onPress} modifiers={modifiers}>
          <SwiftUI.Image
            systemName={symbol as never}
            size={BAR_SYMBOL_SIZE}
            color={accent ? "#ffffff" : "#e6edf3"}
          />
        </SwiftUI.Button>
      </SwiftUI.Host>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [
        styles.btn,
        accent && styles.accent,
        { width: size, height: size, borderRadius: size / 2 },
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.glyph}>{fallback}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    backgroundColor: "#1e1e1e",
    alignItems: "center",
    justifyContent: "center",
  },
  accent: { backgroundColor: "#238636" },
  pressed: { opacity: 0.6 },
  glyph: { color: "#c9d1d9", fontSize: 15 },
});
