// The terminal view: a dumb cell-grid painter, exactly as the protocol
// intends. Frames arrive (snapshot fully replaces, diff patches rows), the
// grid is redrawn into an SkPicture off the React render path, and a hidden
// TextInput plus a special-keys bar feed input back as base64 bytes.
//
// TODO(perf, responsiveness budget): repaint only dirty rows into cached
// per-row pictures instead of re-recording the full grid each frame.

import {
  Canvas,
  matchFont,
  Picture,
  SkFont,
  SkPicture,
  Skia,
} from "@shopify/react-native-skia";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { AttachHandle, attachFrames, ConnectionConfig } from "../client";
import {
  CellData,
  Cursor,
  FLAG_BOLD,
  FLAG_FAINT,
  FLAG_INVERSE,
  FLAG_WIDE_SPACER,
  Frame,
  inputMessage,
} from "../proto";

const BG = "#0d1117";
const FG = "#c9d1d9";
const FONT_SIZE = 12;

// Font creation touches Skia's native module, so it must not run at module
// load (a throw there black-screens the whole app before any UI mounts).
// Lazily initialized on first Terminal mount instead.
interface FontInfo {
  font: SkFont;
  cellW: number;
  cellH: number;
  baseline: number;
}
let fontInfo: FontInfo | null = null;
function getFontInfo(): FontInfo {
  if (!fontInfo) {
    const fontFamily = Platform.select({ ios: "Menlo", default: "monospace" });
    const font = matchFont({ fontFamily, fontSize: FONT_SIZE });
    const metrics = font.getMetrics();
    fontInfo = {
      font,
      cellW: font.getTextWidth("0"),
      cellH: Math.ceil(-metrics.ascent + metrics.descent),
      baseline: Math.ceil(-metrics.ascent),
    };
  }
  return fontInfo;
}

interface Props {
  cfg: ConnectionConfig;
  session: string;
  onBack(): void;
}

export function Terminal({ cfg, session, onBack }: Props) {
  const [picture, setPicture] = useState<SkPicture | null>(null);
  const [status, setStatus] = useState("connecting…");
  const [echoMs, setEchoMs] = useState<number | null>(null);
  const [ctrl, setCtrl] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });

  const grid = useRef<CellData[][]>([]);
  const cursor = useRef<Cursor>({ x: 0, y: 0, visible: false });
  const handle = useRef<AttachHandle | null>(null);
  const inputSentAt = useRef<number | null>(null);
  const inputRef = useRef<TextInput>(null);
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrl;

  const paints = useRef(new Map<string, ReturnType<typeof Skia.Paint>>());
  const paintFor = (color: string) => {
    let p = paints.current.get(color);
    if (!p) {
      p = Skia.Paint();
      p.setColor(Skia.Color(color));
      paints.current.set(color, p);
    }
    return p;
  };

  const repaint = useCallback(() => {
    const { font, cellW: CELL_W, cellH: CELL_H, baseline: BASELINE } = getFontInfo();
    const rows = grid.current.length;
    if (rows === 0) return;
    const cols = grid.current[0]?.length ?? 0;
    const rec = Skia.PictureRecorder();
    const canvas = rec.beginRecording(
      Skia.XYWHRect(0, 0, cols * CELL_W, rows * CELL_H),
    );
    for (let y = 0; y < rows; y++) {
      const line = grid.current[y];
      const baseY = y * CELL_H + BASELINE;
      // Backgrounds first, then coalesce same-style text runs.
      for (let x = 0; x < line.length; x++) {
        const c = line[x];
        const inverse = c.fl & FLAG_INVERSE;
        const bg = inverse ? (c.fg ?? [201, 209, 217]) : c.bg;
        if (bg) {
          canvas.drawRect(
            Skia.XYWHRect(x * CELL_W, y * CELL_H, CELL_W, CELL_H),
            paintFor(`rgb(${bg[0]},${bg[1]},${bg[2]})`),
          );
        }
      }
      let run = "";
      let runStart = 0;
      let runColor = "";
      const flush = () => {
        if (run !== "") {
          canvas.drawText(run, runStart * CELL_W, baseY, paintFor(runColor), font);
        }
        run = "";
      };
      for (let x = 0; x < line.length; x++) {
        const c = line[x];
        if (c.fl & FLAG_WIDE_SPACER) {
          run += " "; // keep columns aligned; the wide glyph overdraws
          continue;
        }
        const inverse = c.fl & FLAG_INVERSE;
        const fgTriple = inverse ? (c.bg ?? [13, 17, 23]) : c.fg;
        let color = fgTriple ? `rgb(${fgTriple[0]},${fgTriple[1]},${fgTriple[2]})` : FG;
        if (c.fl & FLAG_FAINT) color = color === FG ? "#8b949e" : color;
        if (color !== runColor && run !== "") flush();
        if (run === "") {
          runStart = x;
          runColor = color;
        }
        run += c.t === "" ? " " : c.t;
        if (c.fl & FLAG_BOLD) {
          // Cheap bold: overdraw shifted by half a pixel.
          flush();
          canvas.drawText(
            line[x].t || " ",
            x * CELL_W + 0.5,
            baseY,
            paintFor(color),
            font,
          );
          runStart = x + 1;
          runColor = color;
        }
      }
      flush();
    }
    if (cursor.current.visible) {
      const p = paintFor("rgba(201,209,217,0.55)");
      canvas.drawRect(
        Skia.XYWHRect(cursor.current.x * CELL_W, cursor.current.y * CELL_H, CELL_W, CELL_H),
        p,
      );
    }
    setPicture(rec.finishRecordingAsPicture());
  }, []);

  const applyFrame = useCallback(
    (frame: Frame) => {
      if (inputSentAt.current !== null) {
        setEchoMs(Math.round(Date.now() - inputSentAt.current));
        inputSentAt.current = null;
      }
      if (frame.kind === "snapshot") {
        grid.current = [];
        for (let y = 0; y < frame.rows; y++) grid.current.push([]);
      }
      for (const row of frame.lines) {
        if (row.y < grid.current.length) grid.current[row.y] = row.cells;
      }
      cursor.current = frame.cursor;
      repaint();
    },
    [repaint],
  );

  useEffect(() => {
    let alive = true;
    let h: AttachHandle | null = null;
    attachFrames(cfg, session, {
      frame: (f) => alive && applyFrame(f),
      exited: (code) => alive && setStatus(`exited(${code ?? "?"})`),
      error: (m) => alive && setStatus(`error: ${m}`),
      closed: () => alive && setStatus((s) => (s.startsWith("exited") ? s : "disconnected")),
    })
      .then((got) => {
        if (!alive) return got.detach();
        h = got;
        handle.current = got;
        setStatus("");
      })
      .catch((e) => alive && setStatus(String(e.message ?? e)));
    return () => {
      alive = false;
      h?.detach();
      handle.current = null;
    };
  }, [cfg, session, applyFrame]);

  // Fit the PTY to the canvas whenever layout changes.
  useEffect(() => {
    if (size.w === 0 || !handle.current) return;
    const { cellW, cellH } = getFontInfo();
    const cols = Math.max(20, Math.floor(size.w / cellW));
    const rows = Math.max(5, Math.floor(size.h / cellH));
    handle.current.send({ type: "resize", rows, cols });
  }, [size, status]);

  const sendText = (text: string) => {
    if (text === "") return;
    if (ctrlRef.current && text.length === 1) {
      const code = text.toUpperCase().charCodeAt(0);
      if (code >= 64 && code < 96) text = String.fromCharCode(code & 0x1f);
      setCtrl(false);
    }
    inputSentAt.current = Date.now();
    handle.current?.send(inputMessage(text));
  };

  const key = (label: string, seq: string, opts?: { sticky?: boolean }) => (
    <Pressable
      key={label}
      onPress={() => (opts?.sticky ? setCtrl((v) => !v) : sendText(seq))}
      style={[styles.key, opts?.sticky && ctrl ? styles.keyActive : null]}
    >
      <Text style={styles.keyText}>{label}</Text>
    </Pressable>
  );

  const cols = grid.current[0]?.length ?? 0;
  const rows = grid.current.length;

  return (
    <View style={styles.root}>
      <View style={styles.bar}>
        <Pressable onPress={onBack} style={styles.key}>
          <Text style={styles.keyText}>‹ back</Text>
        </Pressable>
        <Text style={styles.overlay}>
          {session} · {cols}×{rows}
          {echoMs !== null ? ` · echo ${echoMs}ms` : ""}
          {status ? ` · ${status}` : ""}
        </Text>
      </View>
      <Pressable
        style={styles.canvasWrap}
        onPress={() => inputRef.current?.focus()}
        onLayout={(e) =>
          setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
        }
      >
        <Canvas style={styles.canvas}>{picture && <Picture picture={picture} />}</Canvas>
      </Pressable>
      <View style={styles.keys}>
        {key("esc", "\x1b")}
        {key("tab", "\t")}
        {key("ctrl", "", { sticky: true })}
        {key("^C", "\x03")}
        {key("←", "\x1b[D")}
        {key("↓", "\x1b[B")}
        {key("↑", "\x1b[A")}
        {key("→", "\x1b[C")}
        {key("⌫", "\x7f")}
      </View>
      <TextInput
        ref={inputRef}
        style={styles.hiddenInput}
        value=""
        onChangeText={sendText}
        onKeyPress={(e) => {
          if (e.nativeEvent.key === "Backspace") sendText("\x7f");
        }}
        onSubmitEditing={() => sendText("\r")}
        submitBehavior="submit"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoFocus
        multiline={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  overlay: { color: "#8b949e", fontSize: 12, flexShrink: 1 },
  canvasWrap: { flex: 1 },
  canvas: { flex: 1 },
  keys: {
    flexDirection: "row",
    justifyContent: "space-evenly",
    paddingVertical: 6,
    backgroundColor: "#161b22",
  },
  key: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "#21262d",
  },
  keyActive: { backgroundColor: "#388bfd" },
  keyText: { color: FG, fontSize: 13 },
  hiddenInput: { height: 1, opacity: 0, position: "absolute", bottom: 0 },
});
