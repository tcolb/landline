import { requireNativeModule, requireNativeViewManager } from "expo-modules-core";
import * as React from "react";
import { Platform, ViewProps } from "react-native";

export interface KeyInputProps extends ViewProps {
  focused: boolean;
  /** Increment to re-request the keyboard (edge-triggered focus). */
  focusNonce: number;
  onInsertText(event: { nativeEvent: { text: string } }): void;
  onDeleteBackward(): void;
}

/** iOS-only raw key input view (UIKeyInput). Null elsewhere — and null on
 * an app binary built before this module existed, so JS updates degrade
 * to the TextInput path instead of crashing. */
export const LandlineKeyInput: React.ComponentType<KeyInputProps> | null = (() => {
  if (Platform.OS !== "ios") return null;
  try {
    return requireNativeViewManager("LandlineKeyInput");
  } catch {
    return null;
  }
})();

/** Device display corner radius in points (0 = square / unknown / old
 * binary). Used to match the drawer's displaced card to hardware corners. */
export async function getScreenCornerRadius(): Promise<number> {
  if (Platform.OS !== "ios") return 0;
  try {
    const mod = requireNativeModule("LandlineKeyInput");
    const r = await mod.getScreenCornerRadius();
    return typeof r === "number" ? r : 0;
  } catch {
    return 0;
  }
}
