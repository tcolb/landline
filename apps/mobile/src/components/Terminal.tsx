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
  Group,
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
import { LandlineKeyInput } from "../../modules/key-input";
import { AttachHandle, attachFrames, ConnectionConfig } from "../client";
import { stats } from "../stats";
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

const BG = "#000000";
const FG = "#c9d1d9";
const FONT_SIZE = 12;
/** Zero-width-space deletion cushion. 64 chars ≈ 4s of held auto-repeat
 * between input remounts (the only reset RN reliably applies). */
const SENTINEL = "\u200b".repeat(64);

// Font creation touches Skia's native module, so it must not run at module
// load (a throw there black-screens the whole app before any UI mounts).
// Lazily initialized on first Terminal mount instead.
interface FontInfo {
  font: SkFont;
  boldFont: SkFont;
  family: string;
  cellW: number;
  cellH: number;
  baseline: number;
}
let fontInfo: FontInfo | null = null;
function getFontInfo(): FontInfo {
  if (!fontInfo) {
    // Don't trust a family name to resolve: if matchFont silently falls
    // back to a proportional face, real glyph advances exceed the assumed
    // cell width and the grid runs off the screen edge. Verify
    // monospacedness (i and W same advance) and walk candidates.
    const candidates: string[] = Platform.select({
      ios: ["Menlo", "Courier New", "Courier"],
      default: ["monospace", "Droid Sans Mono", "Courier New"],
    })!;
    // Cell width must be the glyph ADVANCE, not ink bounds: text runs are
    // positioned by Skia's real advances, so a smaller assumed cell makes
    // every run drift right and pushes the last columns off-screen.
    const advance = (f: SkFont, ch: string) => f.getGlyphWidths(f.getGlyphIDs(ch, 1))[0] ?? 0;
    let family = candidates[candidates.length - 1];
    let font = matchFont({ fontFamily: family, fontSize: FONT_SIZE });
    for (const fam of candidates) {
      const f = matchFont({ fontFamily: fam, fontSize: FONT_SIZE });
      const wi = advance(f, "i");
      if (wi > 0 && Math.abs(wi - advance(f, "W")) < 0.01) {
        family = fam;
        font = f;
        break;
      }
    }
    const boldFont = matchFont({ fontFamily: family, fontSize: FONT_SIZE, fontWeight: "bold" });
    const metrics = font.getMetrics();
    fontInfo = {
      font,
      boldFont,
      family,
      cellW: advance(font, "0"),
      cellH: Math.ceil(-metrics.ascent + metrics.descent),
      baseline: Math.ceil(-metrics.ascent),
    };
  }
  return fontInfo;
}

const paintCache = new Map<string, ReturnType<typeof Skia.Paint>>();
/** Text paint: antialiased. */
function paintFor(color: string) {
  let p = paintCache.get(color);
  if (!p) {
    p = Skia.Paint();
    p.setColor(Skia.Color(color));
    paintCache.set(color, p);
  }
  return p;
}
/** Fill paint for rects (backgrounds, blocks, cursor): antialiasing OFF.
 * Cell rects sit on fractional x (fractional glyph advance); AA feathers
 * each edge and adjacent feathered edges read as hairline seams. */
function fillPaintFor(color: string, alpha?: number) {
  const key = alpha === undefined ? `fill:${color}` : `fill:${color}@${alpha}`;
  let p = paintCache.get(key);
  if (!p) {
    p = Skia.Paint();
    p.setColor(Skia.Color(color));
    p.setAntiAlias(false);
    if (alpha !== undefined) p.setAlphaf(alpha);
    paintCache.set(key, p);
  }
  return p;
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
  // Fast path: ASCII/Latin/punctuation only. Symbol blocks start early
  // (U+23F5 ⏵ is Misc Technical) — everything above goes through the
  // cached coverage check.
  if (cp < 0x2000) return null;
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
    // Last resort: scan every installed family for coverage. One-time per
    // codepoint (cached), so the cost is bounded.
    if (!result) {
      const n = mgr.countFamilies();
      for (let i = 0; i < n; i++) {
        const typeface = mgr.matchFamilyStyle(mgr.getFamilyName(i), FontStyle.Normal);
        if (!typeface) continue;
        const candidate = Skia.Font(typeface, FONT_SIZE);
        if (candidate.getGlyphIDs(t, 1)[0] !== 0) {
          result = candidate;
          break;
        }
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

/** Record one row (backgrounds, style-batched text runs, block rects,
 * glyph fallback) into its own picture, in row-local coordinates. */
function recordRow(cells: CellData[]): SkPicture {
  const { font, boldFont, cellW: CELL_W, cellH: CELL_H, baseline: BASELINE } = getFontInfo();
  const rec = Skia.PictureRecorder();
  const canvas = rec.beginRecording(
    Skia.XYWHRect(0, 0, Math.max(1, cells.length) * CELL_W, CELL_H),
  );
  // Backgrounds as run-length batches: one rect per same-color stretch, so
  // adjacent colored cells share no interior edges (no hairline seams).
  {
    let bgStart = 0;
    let bgColor: string | null = null;
    const flushBg = (end: number) => {
      if (bgColor !== null) {
        canvas.drawRect(
          Skia.XYWHRect(bgStart * CELL_W, 0, (end - bgStart) * CELL_W, CELL_H),
          fillPaintFor(bgColor),
        );
      }
    };
    for (let x = 0; x < cells.length; x++) {
      const c = cells[x];
      const inverse = c.fl & FLAG_INVERSE;
      const bg = inverse ? (c.fg ?? [201, 209, 217]) : c.bg;
      const color = bg ? `rgb(${bg[0]},${bg[1]},${bg[2]})` : null;
      if (color !== bgColor) {
        flushBg(x);
        bgColor = color;
        bgStart = x;
      }
    }
    flushBg(cells.length);
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
        BASELINE,
        paintFor(runColor),
        runBold ? boldFont : font,
      );
    }
    run = "";
  };
  for (let x = 0; x < cells.length; x++) {
    const c = cells[x];
    if (c.fl & FLAG_WIDE_SPACER) {
      run += " "; // keep columns aligned; the wide glyph overdraws
      continue;
    }
    const inverse = c.fl & FLAG_INVERSE;
    const fgTriple = inverse ? (c.bg ?? [0, 0, 0]) : c.fg;
    let color = fgTriple ? `rgb(${fgTriple[0]},${fgTriple[1]},${fgTriple[2]})` : FG;
    if (c.fl & FLAG_FAINT) color = color === FG ? "#8b949e" : color;
    const bold = (c.fl & FLAG_BOLD) !== 0;
    const t = c.t === "" ? " " : c.t;
    // Box-art blocks render as rects, not glyphs (no font seams).
    if (
      drawBlockChar(canvas, t, x * CELL_W, 0, CELL_W, CELL_H, fillPaintFor(color), (alpha) =>
        fillPaintFor(color, alpha),
      )
    ) {
      flush();
      continue;
    }
    const fallback = fontForGlyph(t);
    if (fallback) {
      flush();
      canvas.drawText(t, x * CELL_W, BASELINE, paintFor(color), fallback);
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
  return rec.finishRecordingAsPicture();
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
  // seq/ack correlation (docs/PROFILING.md): every input carries a seq;
  // frames ack the highest seq written to the PTY; latency resolves when
  // the acking frame has been composed — one clock, honest under load.
  const seqCounter = useRef(0);
  const pendingInputs = useRef(new Map<number, number>());
  const lastAck = useRef(0);
  /** Arrival metadata of the frame that most recently raised lastAck. */
  const ackMeta = useRef<{ arrivedAt: number; kind: string; rows: number } | null>(null);
  const msgsSinceCompose = useRef(0);
  const [showStats, setShowStats] = useState(false);
  const [, forceTick] = useState(0);
  /** Shadow of the hidden input's native contents (uncontrolled field). */
  const lastField = useRef(SENTINEL);
  /** Pre-reset contents, kept until an event confirms the reset landed. */
  const preReset = useRef<string | null>(null);
  /** Bumped to remount the input: setNativeProps({text}) is a silent no-op
   * on the new architecture, so remount is the only dependable refill. */
  const [inputEpoch, setInputEpoch] = useState(0);
  /** iOS native key view focus (soft keyboard visibility). */
  const [kbFocused, setKbFocused] = useState(true);
  const [focusNonce, setFocusNonce] = useState(1);
  const inputRef = useRef<TextInput>(null);
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrl;

  // Per-row picture cache: only rows a diff touched are re-recorded; the
  // final picture just composes cached rows + cursor. This is the
  // dirty-row-only repaint from the responsiveness budget.
  const rowPics = useRef<(SkPicture | null)[]>([]);
  // Rows changed since the last compose. Frames can arrive much faster
  // than the display refreshes (held-key redraw storms); recording only
  // each dirty row's FINAL state once per animation frame keeps the JS
  // thread ahead of the message queue instead of drowning in it.
  const dirtyRows = useRef<Set<number>>(new Set());
  const composeScheduled = useRef(false);

  const compose = useCallback(() => {
    const t0 = performance.now();
    const { cellW: CELL_W, cellH: CELL_H } = getFontInfo();
    const rows = rowPics.current.length;
    if (rows === 0) return;
    for (const y of dirtyRows.current) {
      if (y < grid.current.length) rowPics.current[y] = recordRow(grid.current[y]);
    }
    dirtyRows.current.clear();
    const tRecorded = performance.now();
    let cols = 0;
    for (const r of grid.current) cols = Math.max(cols, r.length);
    const rec = Skia.PictureRecorder();
    const canvas = rec.beginRecording(
      Skia.XYWHRect(0, 0, Math.max(1, cols) * CELL_W, rows * CELL_H),
    );
    for (let y = 0; y < rows; y++) {
      const pic = rowPics.current[y];
      if (!pic) continue;
      canvas.save();
      canvas.translate(0, y * CELL_H);
      canvas.drawPicture(pic);
      canvas.restore();
    }
    if (cursor.current.visible) {
      canvas.drawRect(
        Skia.XYWHRect(cursor.current.x * CELL_W, cursor.current.y * CELL_H, CELL_W, CELL_H),
        fillPaintFor("rgba(201,209,217,0.55)"),
      );
    }
    setPicture(rec.finishRecordingAsPicture());
    const now = performance.now();
    stats.record.add(tRecorded - t0);
    stats.compose.add(now - tRecorded);
    const msgsThisTick = msgsSinceCompose.current;
    stats.msgsPerTick.add(msgsThisTick);
    msgsSinceCompose.current = 0;
    // Resolve e2e latency for every input the composed state acks, split
    // into pre-arrival (network + server) and post-arrival (client).
    const meta = ackMeta.current;
    for (const [seq, sentAt] of pendingInputs.current) {
      if (seq <= lastAck.current) {
        const ms = now - sentAt;
        const arrivedAt = meta ? meta.arrivedAt : now;
        stats.addResolved({
          seq,
          e2e_ms: Math.round(ms * 10) / 10,
          pre_ms: Math.round(Math.max(0, arrivedAt - sentAt) * 10) / 10,
          post_ms: Math.round(Math.max(0, now - arrivedAt) * 10) / 10,
          frame_kind: meta?.kind ?? "?",
          frame_rows: meta?.rows ?? 0,
          msgs_in_tick: msgsThisTick,
        });
        setEchoMs(Math.round(ms));
        pendingInputs.current.delete(seq);
      }
    }
  }, []);

  // Coalesce: frames can arrive faster than the display refreshes; compose
  // at most once per animation frame.
  const scheduleCompose = useCallback(() => {
    if (composeScheduled.current) return;
    composeScheduled.current = true;
    requestAnimationFrame(() => {
      composeScheduled.current = false;
      try {
        compose();
      } catch (e: any) {
        setStatus(`render error: ${String(e?.message ?? e)}`);
      }
    });
  }, [compose]);

  const applyFrame = useCallback(
    (frame: Frame) => {
      const t0 = performance.now();
      msgsSinceCompose.current++;
      stats.rowsPerFrame.add(frame.lines.length);
      if (frame.ack !== undefined) {
        // The daemon's seq space is session-global and survives re-attach;
        // adopt it, or our restarted counter sits below the current ack and
        // every input resolves instantly against stale state.
        if (frame.ack > seqCounter.current && pendingInputs.current.size === 0) {
          seqCounter.current = frame.ack;
          lastAck.current = frame.ack;
        }
        if (frame.ack > lastAck.current) {
          lastAck.current = frame.ack;
          ackMeta.current = {
            arrivedAt: performance.now(),
            kind: frame.kind,
            rows: frame.lines.length,
          };
        }
      }
      if (frame.kind === "snapshot") {
        grid.current = [];
        rowPics.current = [];
        dirtyRows.current.clear();
        for (let y = 0; y < frame.rows; y++) {
          grid.current.push([]);
          rowPics.current.push(null);
          dirtyRows.current.add(y);
        }
      }
      for (const row of frame.lines) {
        if (row.y < grid.current.length) {
          grid.current[row.y] = row.cells;
          dirtyRows.current.add(row.y);
        }
      }
      cursor.current = frame.cursor;
      if (frame.mouse !== undefined) mouseMode.current = frame.mouse;
      stats.apply.add(performance.now() - t0);
      scheduleCompose();
    },
    [scheduleCompose],
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
        if (Math.abs(g.dy) < 6 && Math.abs(g.dx) < 6) {
          setKbFocused(true);
          setFocusNonce((n) => n + 1);
          inputRef.current?.focus();
        }
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

  // Keepalive: an empty input every 300ms while attached. Keeps the phone
  // Wi-Fi radio out of power-save, which otherwise costs the first
  // keystroke after an idle gap a ~100ms wake-up (visible as pre_ms spikes
  // in the slow-frame trace). The daemon ignores empty inputs entirely.
  useEffect(() => {
    const id = setInterval(() => {
      handle.current?.send(inputMessage(""));
    }, 300);
    return () => clearInterval(id);
  }, []);

  // Live-refresh the stats panel while it is open.
  useEffect(() => {
    if (!showStats) return;
    const id = setInterval(() => forceTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [showStats]);

  // Fit the PTY to the canvas whenever layout changes. The 2px margin
  // absorbs fractional cell-width rounding so the last column can never
  // fall off the screen edge.
  useEffect(() => {
    if (size.w === 0 || !handle.current) return;
    const { cellW, cellH } = getFontInfo();
    const cols = Math.max(20, Math.floor((size.w - 2) / cellW));
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
    const seq = ++seqCounter.current;
    pendingInputs.current.set(seq, performance.now());
    // Bound the map in case acks never come (exited session).
    if (pendingInputs.current.size > 256) {
      const oldest = pendingInputs.current.keys().next().value;
      if (oldest !== undefined) pendingInputs.current.delete(oldest);
    }
    handle.current?.send(inputMessage(text, seq));
  };

  // Hold-to-repeat for bar keys (the system keyboard's delete only
  // auto-repeats for full UITextInput implementers, which UIKeyInput is
  // not): after an initial delay, repeat with mild acceleration until
  // release.
  const repeatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopRepeat = () => {
    if (repeatTimer.current !== null) {
      clearTimeout(repeatTimer.current);
      repeatTimer.current = null;
    }
  };
  const startRepeat = (seq: string) => {
    stopRepeat();
    let interval = 110;
    const tick = () => {
      sendText(seq);
      interval = Math.max(40, interval - 8);
      repeatTimer.current = setTimeout(tick, interval);
    };
    repeatTimer.current = setTimeout(tick, 350);
  };
  useEffect(() => stopRepeat, []);

  const key = (
    label: string,
    seq: string,
    opts?: { sticky?: boolean; repeat?: boolean },
  ) => (
    <Pressable
      key={label}
      onPress={() => (opts?.sticky ? setCtrl((v) => !v) : sendText(seq))}
      onPressIn={opts?.repeat ? () => startRepeat(seq) : undefined}
      onPressOut={opts?.repeat ? stopRepeat : undefined}
      style={[styles.key, opts?.sticky && ctrl ? styles.keyActive : null]}
    >
      <Text style={styles.keyText}>{label}</Text>
    </Pressable>
  );

  const cols = grid.current[0]?.length ?? 0;
  const rows = grid.current.length;
  // Center the grid: split the sub-cell remainder evenly left and right.
  const xOff = Math.max(0, (size.w - cols * getFontInfo().cellW) / 2);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View style={styles.bar}>
        <Pressable onPress={onBack} style={styles.key}>
          <Text style={styles.keyText}>‹ back</Text>
        </Pressable>
        <Pressable style={styles.overlayWrap} onPress={() => setShowStats((v) => !v)}>
          <Text style={styles.overlay}>
            {session} · {cols}×{rows} · {getFontInfo().family}
            {echoMs !== null ? ` · e2e ${echoMs}ms` : ""}
            {status ? ` · ${status}` : ""}
          </Text>
        </Pressable>
      </View>
      {showStats && (
        <View style={styles.statsPanel}>
          {Object.entries(stats.snapshot()).map(([k, v]) => (
            <Text key={k} style={styles.statsLine}>
              {k}: {typeof v === "object" ? JSON.stringify(v) : String(v)}
            </Text>
          ))}
          <Pressable onPress={() => stats.dump()} style={styles.key}>
            <Text style={styles.keyText}>dump to console</Text>
          </Pressable>
        </View>
      )}
      <View
        style={styles.canvasWrap}
        {...pan.panHandlers}
        onLayout={(e) =>
          setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
        }
      >
        <Canvas style={styles.canvas}>
          <Group transform={[{ translateX: xOff }]}>
            {picture && <Picture picture={picture} />}
          </Group>
        </Canvas>
      </View>
      <View style={styles.keys}>
        {key("esc", "\x1b")}
        {key("tab", "\t")}
        {key("ctrl", "", { sticky: true })}
        {key("^C", "\x03")}
        {key("←", "\x1b[D", { repeat: true })}
        {key("↓", "\x1b[B", { repeat: true })}
        {key("↑", "\x1b[A", { repeat: true })}
        {key("→", "\x1b[C", { repeat: true })}
        {key("⌫", "\x7f", { repeat: true })}
        <Pressable
          style={styles.key}
          onPress={() => {
            // Dismissing alone is unreliable while the hidden input holds
            // focus; blur it explicitly first.
            setKbFocused(false);
            inputRef.current?.blur();
            Keyboard.dismiss();
          }}
        >
          <Text style={styles.keyText}>⌄⌨</Text>
        </Pressable>
      </View>
      {LandlineKeyInput !== null ? (
        // iOS: raw UIKeyInput events, one call per keystroke at every
        // auto-repeat stage — no text field, no diffing, no heuristics.
        <LandlineKeyInput
          style={styles.hiddenInput}
          focused={kbFocused}
          focusNonce={focusNonce}
          onInsertText={(e) => {
            const text = e.nativeEvent.text;
            sendText(text === "\n" ? "\r" : text);
          }}
          onDeleteBackward={() => sendText("\x7f")}
        />
      ) : (
      <TextInput
        key={inputEpoch}
        ref={inputRef}
        style={styles.hiddenInput}
        // Sentinel-cushion pattern, uncontrolled: the field starts with 16
        // zero-width spaces and we diff each event against the PREVIOUS
        // contents (a controlled reset lands asynchronously, so diffing
        // against a fresh cushion double-counts under key auto-repeat).
        // Deleted chars → that many backspaces, added chars → typed text.
        // The cushion is replenished imperatively only when it runs low,
        // updating our shadow copy at the same time. No onKeyPress
        // (unreliable on iOS), no assumptions about reset timing.
        defaultValue={SENTINEL}
        onChangeText={(t) => {
          // A programmatic reset races in-flight keyboard events: an event
          // computed from the PRE-reset text diffed against the fresh
          // cushion re-sends the whole typed history. Keep both baselines
          // and diff against whichever explains this event most cheaply.
          const bases =
            preReset.current !== null
              ? [lastField.current, preReset.current]
              : [lastField.current];
          let best = bases[0];
          let bestP = 0;
          let bestCost = Number.POSITIVE_INFINITY;
          for (const b of bases) {
            let p = 0;
            while (p < b.length && p < t.length && b[p] === t[p]) p++;
            const cost = b.length - p + (t.length - p);
            if (cost < bestCost) {
              bestCost = cost;
              best = b;
              bestP = p;
            }
          }
          const removedSlice = best.slice(bestP);
          const added = t.slice(bestP).replaceAll("​", "");
          lastField.current = t;
          if (preReset.current !== null && t.startsWith(SENTINEL)) {
            preReset.current = null; // reset observed; stale window over
          }
          // Removed typed chars map 1:1 to backspaces (they exist on the
          // app's line). A multi-char removal of pure cushion is iOS's
          // held-delete word acceleration chewing the zero-width run —
          // the user's intent is "delete one word", so send word-erase
          // (Ctrl-W) instead of a blind burst of backspaces.
          let realRemoved = 0;
          let zwRemoved = 0;
          for (const ch of removedSlice) {
            if (ch === "​") zwRemoved++;
            else realRemoved++;
          }
          let out = "";
          if (realRemoved > 0) out += "\x7f".repeat(realRemoved);
          if (zwRemoved === 1) out += "\x7f";
          else if (zwRemoved > 1) out += "\x17";
          out += added;
          if (out !== "") sendText(out);
          // Replenish when the cushion runs low (deletions) or the field
          // grows very long (typing); remember the pre-reset text so the
          // stale-event window stays diffable.
          let zw = 0;
          while (zw < t.length && t[zw] === "​") zw++;
          if (zw < 24 || t.length > 512) {
            preReset.current = t;
            lastField.current = SENTINEL;
            setInputEpoch((n) => n + 1);
          }
        }}
        onSubmitEditing={() => {
          sendText("\r");
          // Enter is a natural quiescent point; start the field fresh.
          preReset.current = lastField.current;
          lastField.current = SENTINEL;
          setInputEpoch((n) => n + 1);
        }}
        submitBehavior="submit"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoFocus
        multiline={false}
      />
      )}
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
  overlay: { color: "#8b949e", fontSize: 12 },
  overlayWrap: { flexShrink: 1 },
  statsPanel: {
    position: "absolute",
    top: 40,
    left: 8,
    right: 8,
    zIndex: 10,
    backgroundColor: "rgba(0,0,0,0.94)",
    borderColor: "#2a2a2a",
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    gap: 3,
  },
  statsLine: { color: "#8b949e", fontFamily: "monospace", fontSize: 10 },
  canvasWrap: { flex: 1 },
  canvas: { flex: 1 },
  keys: {
    flexDirection: "row",
    justifyContent: "space-evenly",
    paddingVertical: 6,
    backgroundColor: "#141414",
  },
  key: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "#1e1e1e",
  },
  keyActive: { backgroundColor: "#388bfd" },
  keyText: { color: FG, fontSize: 13 },
  hiddenInput: { height: 1, opacity: 0, position: "absolute", bottom: 0 },
});
