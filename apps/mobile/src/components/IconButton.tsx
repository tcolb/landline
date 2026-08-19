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
    ];
    if (accent) modifiers.push(m.tint("#238636"));
    // The glass pill wraps the label plus system padding; pinning the
    // LABEL's frame (a frame outside the button just boxes it) makes
    // every bar button the same standard circle.
    // Pill = label frame + ~7pt system padding per side; this lands the
    // visible circle on the full standard size.
    const labelFrame = [m.frame({ width: size - 14, height: size - 14 })];
    return (
      <SwiftUI.Host style={{ width: size, height: size }} colorScheme="dark">
        <SwiftUI.Button onPress={onPress} modifiers={modifiers}>
          <SwiftUI.Image
            systemName={symbol as never}
            size={Math.min(BAR_SYMBOL_SIZE, Math.round(size * 0.42))}
            color={accent ? "#ffffff" : "#e6edf3"}
            modifiers={labelFrame}
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

interface PillProps {
  label: string;
  symbol: string;
  onPress(): void;
}

/** Labeled Liquid Glass capsule button (e.g. "+ New Session"). */
export function GlassPillButton({ label, symbol, onPress }: PillProps) {
  if (SwiftUI !== null && SwiftUIModifiers !== null) {
    const m = SwiftUIModifiers;
    return (
      <SwiftUI.Host style={{ width: 180, height: 52 }} colorScheme="dark">
        <SwiftUI.Button
          onPress={onPress}
          label={label}
          systemImage={symbol as never}
          modifiers={[
            m.buttonStyle("glassProminent"),
            m.buttonBorderShape("capsule"),
            m.tint("#238636"),
            m.controlSize("large"),
          ]}
        />
      </SwiftUI.Host>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [pillStyles.pill, pressed && styles.pressed]}
    >
      <Text style={pillStyles.text}>+ {label}</Text>
    </Pressable>
  );
}

const pillStyles = StyleSheet.create({
  pill: {
    backgroundColor: "#238636",
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 13,
  },
  text: { color: "#ffffff", fontWeight: "600", fontSize: 15 },
});

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
