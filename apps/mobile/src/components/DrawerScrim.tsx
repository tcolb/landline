// The washed-out treatment of the displaced scene, rendered INSIDE the
// scene so it clips to the card's corner radius (the drawer's built-in
// overlay sits outside the rounded container and bleeds past the
// corners). Opacity tracks drawer progress on the UI thread.

import React from "react";

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
  const progress = k.useDrawerProgress();
  const style = k.useAnimatedStyle(() => ({
    opacity: (progress.value ?? 0) * 0.08,
  }));
  const A = k.Animated.View;
  return (
    <A
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "#ffffff",
          zIndex: 999,
        },
        style,
      ]}
    />
  );
}

/** Renders nothing when the drawer stack is unavailable. */
export function DrawerScrim() {
  return kit ? <Scrim /> : null;
}
