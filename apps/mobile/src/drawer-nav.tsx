// Guarded drawer navigation (Claude-app-style left sidebar). iOS has no
// system drawer primitive for iPhone — apps in this genre all build it
// from an edge-pan + slide, and the best-in-stack implementation is
// @react-navigation/drawer on react-native-gesture-handler + reanimated
// (UI-thread animation). Null on binaries without the gesture-handler
// native module, so pre-drawer builds keep the stack layout.

import * as React from "react";

export interface DrawerKit {
  createDrawerNavigator: typeof import("@react-navigation/drawer").createDrawerNavigator;
  GestureHandlerRootView: React.ComponentType<{
    style?: object;
    children?: React.ReactNode;
  }>;
}

export const drawerKit: DrawerKit | null = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const gh = require("react-native-gesture-handler");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const drawer = require("@react-navigation/drawer");
    if (!gh.GestureHandlerRootView || !drawer.createDrawerNavigator) return null;
    return {
      createDrawerNavigator: drawer.createDrawerNavigator,
      GestureHandlerRootView: gh.GestureHandlerRootView,
    };
  } catch {
    return null;
  }
})();
