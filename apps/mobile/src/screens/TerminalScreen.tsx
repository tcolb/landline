import { NativeStackScreenProps } from "@react-navigation/native-stack";
import React from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import type { RootStackParams } from "../../App";
import { ConnectionConfig } from "../client";
import { Terminal } from "../components/Terminal";

type Props = NativeStackScreenProps<RootStackParams, "Terminal"> & {
  cfg: ConnectionConfig;
};

export function TerminalScreen({ route, navigation, cfg }: Props) {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#0d1117" }} edges={["top", "bottom"]}>
      <Terminal
        cfg={cfg}
        session={route.params.session}
        onBack={() => navigation.goBack()}
      />
    </SafeAreaView>
  );
}
