// Currently selected session in the drawer layout. A tiny store so the
// spawn modal (on the root stack, outside the drawer) can select the
// session it just created.

import { create } from "zustand";
import { SessionSelection } from "./screens/SessionDrawer";

interface SelectionState {
  selection: SessionSelection | null;
  setSelection(sel: SessionSelection | null): void;
}

export const useSelection = create<SelectionState>((set) => ({
  selection: null,
  setSelection: (selection) => set({ selection }),
}));
