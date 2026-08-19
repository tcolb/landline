import { requireNativeViewManager } from "expo-modules-core";
import * as React from "react";
import { Platform, ViewProps } from "react-native";

export interface KeyInputProps extends ViewProps {
  focused: boolean;
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
