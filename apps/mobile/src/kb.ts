// App-wide keyboard dismissal. RN's Keyboard.dismiss() only blurs the
// TextInputs RN itself tracks — the terminal's native key-input view
// (UITextInput) is invisible to it, so views owning such inputs register
// here and blur themselves on demand.

import { Keyboard } from "react-native";

const listeners = new Set<() => void>();

export function onDismissAllKeyboards(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function dismissAllKeyboards() {
  Keyboard.dismiss();
  listeners.forEach((fn) => fn());
}
