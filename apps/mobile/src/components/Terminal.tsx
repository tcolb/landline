// The terminal view: a dumb cell-grid painter, exactly as the protocol
// intends. Frames arrive (snapshot fully replaces, diff patches rows), the
// grid is redrawn into an SkPicture off the React render path, and a hidden
// TextInput plus a special-keys bar feed input back as base64 bytes.
//
// TODO(perf, responsiveness budget): repaint only dirty rows into cached
// per-row pictures instead of re-recording the full grid each frame.

import {
  Canvas,
  FontStyle,
  matchFont,
  Picture,
  SkFont,
  SkPicture,
  Skia,
} from "@shopify/react-native-skia";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  PanResponder,
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
  boldFont: SkFont;
  cellW: number;
  cellH: number;
  baseline: number;
}
let fontInfo: FontInfo | null = null;
function getFontInfo(): FontInfo {
  if (!fontInfo) {
    const fontFamily = Platform.select({ ios: "Menlo", default: "monospace" });
    const font = matchFont({ fontFamily, fontSize: FONT_SIZE });
    const boldFont = matchFont({ fontFamily, fontSize: FONT_SIZE, fontWeight: "bold" });
    const metrics = font.getMetrics();
    fontInfo = {
      font,
      boldFont,
      cellW: font.getTextWidth("0"),
      cellH: Math.ceil(-metrics.ascent + metrics.descent),
      baseline: Math.ceil(-metrics.ascent),
    };
  }
  return fontInfo;
}

// Glyph fallback: monospace fonts miss plenty (emoji, ⏵, ❯, CJK) and Skia
// does no automatic substitution. For any grapheme the main font lacks a
// glyph for, probe candidate families for real coverage; cached per
// codepoint. Codepoints below U+2500 are assumed covered (fast path —
// ASCII, Latin, punctuation; box drawing above that renders as rects).
const FALLBACK_FAMILIES: string[] = Platform.select({
  ios: ["Apple Symbols", "Apple Color Emoji", "Hiragino Sans", "Helvetica"],
  default: ["sans-serif", "Noto Color Emoji", "Noto Sans CJK SC"],
})!;
const glyphCache = new Map<number, SkFont | null>(); // null = main font is fine
function fontForGlyph(t: string): SkFont | null {
  const cp = t.codePointAt(0) ?? 0;
  if (cp < 0x2500) return null;
  const cached = glyphCache.get(cp);
  if (cached !== undefined) return cached;
  const { font } = getFontInfo();
  let result: SkFont | null = null;
  if (font.getGlyphIDs(t, 1)[0] === 0) {
    const mgr = Skia.FontMgr.System();
    for (const family of FALLBACK_FAMILIES) {
      const typeface = mgr.matchFamilyStyle(family, FontStyle.Normal);
      if (!typeface) continue;
      const candidate = Skia.Font(typeface, FONT_SIZE);
      if (candidate.getGlyphIDs(t, 1)[0] !== 0) {
        result = candidate;
        break;
      }
    }
  }
  glyphCache.set(cp, result);
  return result;
}

// Block elements (U+2580–U+259F) drawn as glyphs leave seams and stray
// gaps — fonts don't fill the cell box exactly. Terminals draw them as
// filled rects; returns true when the char was handled that way.
// Fractions are eighths; quadrant chars use a UL/UR/LL/LR bitmask.
const QUADRANTS: Record<string, number> = {
  "▖": 0b0010, "▗": 0b0001, "▘": 0b1000, "▙": 0b1011,
  "▚": 0b1001, "▛": 0b1110, "▜": 0b1101, "▝": 0b0100,
  "▞": 0b0110, "▟": 0b0111,
};
function drawBlockChar(
  canvas: { drawRect(rect: unknown, paint: unknown): void },
  ch: string,
  px: number,
  py: number,
  w: number,
  h: number,
  paint: unknown,
  shadePaint: (alpha: number) => unknown,
): boolean {
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x2580 || code > 0x259f) return false;
  const rect = (x: number, y: number, rw: number, rh: number) =>
    canvas.drawRect(Skia.XYWHRect(px + x, py + y, rw, rh), paint);
  if (code === 0x2588) rect(0, 0, w, h); // full block
  else if (code === 0x2580) rect(0, 0, w, h / 2); // upper half
  else if (code >= 0x2581 && code <= 0x2587) {
    const k = (code - 0x2580) / 8; // lower eighths ▁..▇
    rect(0, h * (1 - k), w, h * k);
  } else if (code === 0x258c) rect(0, 0, w / 2, h); // left half
  else if (code >= 0x2589 && code <= 0x258f) {
    const k = (0x2590 - code) / 8; // left eighths ▉..▏
    rect(0, 0, w * k, h);
  } else if (code === 0x2590) rect(w / 2, 0, w / 2, h); // right half
  else if (code === 0x2591) canvas.drawRect(Skia.XYWHRect(px, py, w, h), shadePaint(0.25));
  else if (code === 0x2592) canvas.drawRect(Skia.XYWHRect(px, py, w, h), shadePaint(0.5));
  else if (code === 0x2593) canvas.drawRect(Skia.XYWHRect(px, py, w, h), shadePaint(0.75));
  else if (code === 0x2594) rect(0, 0, w, h / 8); // upper eighth
  else if (code === 0x2595) rect(w * (7 / 8), 0, w / 8, h); // right eighth
  else {
    const q = QUADRANTS[ch] ?? 0;
    if (q & 0b1000) rect(0, 0, w / 2, h / 2);
    if (q & 0b0100) rect(w / 2, 0, w / 2, h / 2);
    if (q & 0b0010) rect(0, h / 2, w / 2, h / 2);
    if (q & 0b0001) rect(w / 2, h / 2, w / 2, h / 2);
  }
  return true;
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
    try {
      repaintInner();
    } catch (e: any) {
      setStatus(`render error: ${String(e?.message ?? e)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const repaintInner = useCallback(() => {
    const {
      font,
      boldFont,
      cellW: CELL_W,
      cellH: CELL_H,
      baseline: BASELINE,
    } = getFontInfo();
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
      let runBold = false;
      const flush = () => {
        if (run !== "") {
          canvas.drawText(
            run,
            runStart * CELL_W,
            baseY,
            paintFor(runColor),
            runBold ? boldFont : font,
          );
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
        const bold = (c.fl & FLAG_BOLD) !== 0;
        const t = c.t === "" ? " " : c.t;
        // Box-art blocks render as rects, not glyphs (no font seams).
        if (
          drawBlockChar(
            canvas,
            t,
            x * CELL_W,
            y * CELL_H,
            CELL_W,
            CELL_H,
            paintFor(color),
            (alpha) => {
              const key = `${color}@${alpha}`;
              let p = paints.current.get(key);
              if (!p) {
                p = Skia.Paint();
                p.setColor(Skia.Color(color));
                p.setAlphaf(alpha);
                paints.current.set(key, p);
              }
              return p;
            },
          )
        ) {
          flush();
          continue;
        }
        const fallback = fontForGlyph(t);
        if (fallback) {
          flush();
          canvas.drawText(t, x * CELL_W, baseY, paintFor(color), fallback);
          continue;
        }
        if ((color !== runColor || bold !== runBold) && run !== "") flush();
        if (run === "") {
          runStart = x;
          runColor = color;
          runBold = bold;
        }
        run += t;
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
      if (frame.mouse !== undefined) mouseMode.current = frame.mouse;
      repaint();
    },
    [repaint],
  );

  // Swipe → scroll. With mouse tracking on (claude, vim, htop) swipes
  // become SGR wheel events at the touch position; otherwise arrow keys —
  // the same translation desktop terminals do for alt-screen apps.
  const mouseMode = useRef(false);
  const panLastDy = useRef(0);
  const panAccum = useRef(0);
  const panCell = useRef({ col: 1, row: 1 });
  const sendScroll = useCallback((up: boolean) => {
    if (mouseMode.current) {
      const { col, row } = panCell.current;
      handle.current?.send(inputMessage(`\x1b[<${up ? 64 : 65};${col};${row}M`));
    } else {
      handle.current?.send(inputMessage(up ? "\x1b[A" : "\x1b[B"));
    }
  }, []);
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 6,
      onPanResponderGrant: (e) => {
        panLastDy.current = 0;
        panAccum.current = 0;
        const { cellW, cellH } = getFontInfo();
        panCell.current = {
          col: Math.max(1, Math.floor(e.nativeEvent.locationX / cellW) + 1),
          row: Math.max(1, Math.floor(e.nativeEvent.locationY / cellH) + 1),
        };
      },
      onPanResponderMove: (_e, g) => {
        const { cellH } = getFontInfo();
        panAccum.current += g.dy - panLastDy.current;
        panLastDy.current = g.dy;
        // Finger down reveals earlier content = wheel/arrow up.
        while (Math.abs(panAccum.current) >= cellH) {
          const up = panAccum.current > 0;
          panAccum.current += up ? -cellH : cellH;
          sendScroll(up);
        }
      },
      onPanResponderRelease: (_e, g) => {
        if (Math.abs(g.dy) < 6 && Math.abs(g.dx) < 6) inputRef.current?.focus();
      },
    }),
  ).current;

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
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
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
      <View
        style={styles.canvasWrap}
        {...pan.panHandlers}
        onLayout={(e) =>
          setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
        }
      >
        <Canvas style={styles.canvas}>{picture && <Picture picture={picture} />}</Canvas>
      </View>
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
        <Pressable
          style={styles.key}
          onPress={() => {
            // Dismissing alone is unreliable while the hidden input holds
            // focus; blur it explicitly first.
            inputRef.current?.blur();
            Keyboard.dismiss();
          }}
        >
          <Text style={styles.keyText}>⌄⌨</Text>
        </Pressable>
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
    </KeyboardAvoidingView>
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
