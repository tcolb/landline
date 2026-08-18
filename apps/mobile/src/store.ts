// Client state: the daemon connection config, persisted so the last host
// and token survive restarts. Server state (sessions) lives in TanStack
// Query; this store is only what the client owns.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { ConnectionConfig } from "./client";

interface ConnectionState {
  /** Last config that passed a hello check; null = never connected. */
  config: ConnectionConfig | null;
  /** True once the persisted state has been read back from disk. */
  hydrated: boolean;
  setConfig(config: ConnectionConfig): void;
  clearConfig(): void;
}

export const useConnection = create<ConnectionState>()(
  persist(
    (set) => ({
      config: null,
      hydrated: false,
      setConfig: (config) => set({ config }),
      clearConfig: () => set({ config: null }),
    }),
    {
      name: "landline.connection",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ config: s.config }),
      onRehydrateStorage: () => () => {
        useConnection.setState({ hydrated: true });
      },
    },
  ),
);
