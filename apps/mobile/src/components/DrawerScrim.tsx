// The washed-out treatment of the displaced scene, rendered INSIDE the
// scene so it clips to the card's corner radius (the drawer's built-in
// overlay sits outside the rounded container and bleeds past the
// corners). Opacity tracks drawer progress on the UI thread.

import React from "react";
import { StyleSheet } from "react-native";
import { useScreenRadius } from "../screen-radius";

const kit: {
  useDrawerProgress: () => { value: number };
  Animated: any;
  useAnimatedStyle: (fn: () => object) => object;
} | null = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const drawer = require("@react-navigation/drawer");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reanimated = require("react-native-reanimated");
    if (!drawer.useDrawerProgress || !reanimated.default) return null;
    return {
      useDrawerProgress: drawer.useDrawerProgress,
      Animated: reanimated.default,
      useAnimatedStyle: reanimated.useAnimatedStyle,
    };
  } catch {
    return null;
  }
})();

function Scrim() {
  const k = kit!;
  const radius = useScreenRadius();
  const progress = k.useDrawerProgress();
  const fillStyle = k.useAnimatedStyle(() => ({
    opacity: (progress.value ?? 0) * 0.08,
  }));
  // Border ramps in fast: any displacement at all shows the card edge,
  // fully invisible only at rest.
  const borderStyle = k.useAnimatedStyle(() => ({
    opacity: Math.min((progress.value ?? 0) * 6, 1),
  }));
  const A = k.Animated.View;
  const fill = {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 999,
  };
  return (
    <>
      <A pointerEvents="none" style={[fill, { backgroundColor: "#ffffff" }, fillStyle]} />
      <A
        pointerEvents="none"
        style={[
          fill,
          {
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: "#3a3a3a",
            borderRadius: radius,
          },
          borderStyle,
        ]}
      />
    </>
  );
}

/** Renders nothing when the drawer stack is unavailable. */
export function DrawerScrim() {
  return kit ? <Scrim /> : null;
}
