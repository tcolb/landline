// Guarded access to @expo/ui's SwiftUI-backed components (native-first UI
// tenet, docs/DESIGN.md). Null on Android and on app binaries built before
// the dependency existed — screens then render their React Native fallback
// instead of crashing.

import { Platform } from "react-native";

export type SwiftUINamespace = typeof import("@expo/ui/swift-ui");

export const SwiftUI: SwiftUINamespace | null = (() => {
  if (Platform.OS !== "ios") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@expo/ui/swift-ui") as SwiftUINamespace;
  } catch {
    return null;
  }
})();
