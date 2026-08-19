// The washed-out treatment of the displaced scene, rendered INSIDE the
// scene so it clips to the card's corner radius (the drawer's built-in
// overlay sits outside the rounded container and bleeds past the
// corners). The wash is a left-weighted gradient — strongest at the edge
// meeting the drawer, gone by ~2/3 across — plus a hairline card border
// that only exists while the card is displaced. Opacity tracks drawer
// progress on the UI thread.

import { Canvas, LinearGradient, Rect, vec } from "@shopify/react-native-skia";
import React from "react";
import { Dimensions, StyleSheet } from "react-native";
import { dismissAllKeyboards } from "../kb";
import { useScreenRadius } from "../screen-radius";

const kit: {
  useDrawerProgress: () => { value: number };
  Animated: any;
  useAnimatedStyle: (fn: () => object) => object;
  useAnimatedReaction: (
    prepare: () => number,
    react: (value: number, previous: number | null) => void,
  ) => void;
  runOnJS: (fn: (...args: any[]) => void) => (...args: any[]) => void;
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
      useAnimatedReaction: reanimated.useAnimatedReaction,
      runOnJS: reanimated.runOnJS,
    };
  } catch {
    return null;
  }
})();

/** Light impact when the drawer settles open or closed. Guarded: no-op
 * on binaries built before expo-haptics was added. */
const settleHaptic = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const haptics = require("expo-haptics");
    return () => {
      haptics.impactAsync(haptics.ImpactFeedbackStyle.Light).catch(() => {});
    };
  } catch {
    return () => {};
  }
})();

function Scrim() {
  const k = kit!;
  // Destructured so worklets capture runOnJS directly — invoking it as a
  // property of a captured object is a host-function call inside the
  // worklet and dies silently on device.
  const { useAnimatedReaction, runOnJS } = k;
  const radius = useScreenRadius();
  const { width, height } = Dimensions.get("window");
  const progress = k.useDrawerProgress();
  // Fire once when the drawer settles at either end (dock/undock release),
  // not on mount and not mid-drag; dismiss the keyboard the moment the
  // card first moves off its docked position.
  useAnimatedReaction(
    () => {
      "worklet";
      return progress.value ?? 0;
    },
    (value, previous) => {
      "worklet";
      if (previous === null || previous === value) return;
      if (previous === 0 && value > 0) {
        runOnJS(dismissAllKeyboards)();
      }
      if ((value === 1 && previous < 1) || (value === 0 && previous > 0)) {
        runOnJS(settleHaptic)();
      }
    },
  );
  // Cubic ease-in: the wash stays imperceptible through the first half of
  // the swipe and blooms toward the docked position.
  const fillStyle = k.useAnimatedStyle(() => {
    const p = progress.value ?? 0;
    return { opacity: p * p * p };
  });
  // Border snaps in at the first pixel of displacement: full strength by
  // 2% progress, invisible only truly at rest.
  const borderStyle = k.useAnimatedStyle(() => ({
    opacity: Math.min((progress.value ?? 0) * 50, 1),
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
      <A pointerEvents="none" style={[fill, fillStyle]}>
        <Canvas style={{ flex: 1 }}>
          <Rect x={0} y={0} width={width} height={height}>
            <LinearGradient
              start={vec(0, 0)}
              end={vec(width * 0.66, 0)}
              colors={["rgba(255,255,255,0.07)", "rgba(255,255,255,0)"]}
            />
          </Rect>
        </Canvas>
      </A>
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

function RevealFx({ children }: { children: React.ReactNode }) {
  const k = kit!;
  const progress = k.useDrawerProgress();
  // Depth treatment for the sidebar: starts recessed (scaled down along z,
  // faded) beneath the card and rises to full presence as the card is
  // pulled away, receding again as it docks.
  const style = k.useAnimatedStyle(() => {
    const p = progress.value ?? 0;
    // Fade lives in the [0.12, 0.6] progress window: completely invisible
    // just before the card fully covers the tray, fully present well
    // before the card finishes leaving.
    const t = Math.min(1, Math.max(0, (p - 0.12) / 0.48));
    return {
      opacity: t,
      transform: [{ scale: 0.95 + p * 0.05 }],
    };
  });
  const A = k.Animated.View;
  return <A style={[{ flex: 1 }, style]}>{children}</A>;
}

/** Wraps the drawer sidebar content with the reveal depth treatment; a
 * plain passthrough when the drawer stack is unavailable. */
export function DrawerRevealFx({ children }: { children: React.ReactNode }) {
  return kit ? <RevealFx>{children}</RevealFx> : <>{children}</>;
}

