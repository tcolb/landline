// Guarded react-native-keyboard-controller: native keyboard animation
// projections (system curve, per-frame) for driving the chat composer's
// position dock. Null on binaries built before the dependency existed —
// callers fall back to reanimated's useAnimatedKeyboard.

export const kbc: {
  KeyboardProvider: React.ComponentType<{ children?: React.ReactNode }>;
  useKeyboardHandler: (
    handlers: Record<string, (e: { height: number; progress: number }) => void>,
    deps?: unknown[],
  ) => void;
} | null = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const k = require("react-native-keyboard-controller");
    if (!k.useKeyboardHandler || !k.KeyboardProvider) return null;
    return { KeyboardProvider: k.KeyboardProvider, useKeyboardHandler: k.useKeyboardHandler };
  } catch {
    return null;
  }
})();
