// Circular bar button with a real SF Symbol — the top-bar control idiom
// of the genre apps (translucent circle, symbol glyph). SwiftUI-backed on
// iOS; text-glyph fallback elsewhere / on pre-module binaries.

import React from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { SwiftUI } from "../native-ui";

interface Props {
  /** SF Symbol name, e.g. "line.3.horizontal", "plus". */
  symbol: string;
  /** Fallback glyph when SwiftUI is unavailable. */
  fallback: string;
  onPress(): void;
  size?: number;
  accent?: boolean;
}

export function IconButton({ symbol, fallback, onPress, size = 32, accent }: Props) {
  const inner =
    SwiftUI !== null ? (
      <SwiftUI.Host
        style={{ width: size * 0.55, height: size * 0.55, backgroundColor: "transparent" }}
        colorScheme="dark"
        pointerEvents="none"
      >
        <SwiftUI.Image systemName={symbol as never} />
      </SwiftUI.Host>
    ) : (
      <Text style={styles.glyph}>{fallback}</Text>
    );
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
      {inner}
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
