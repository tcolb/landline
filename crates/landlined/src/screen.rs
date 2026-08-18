//! Server-side terminal emulation behind the `Screen` trait.
//!
//! The daemon parses PTY bytes exactly once, here; clients only ever see
//! [`Frame`]s. The trait exists so the VT engine (libghostty-vt today) can be
//! swapped without touching session or protocol code.

use landline_proto::wire::{CellData, Cursor, Frame, RowData, cellflags};
use libghostty_vt::{
    RenderState,
    fmt::{Format, Formatter, FormatterOptions},
    render::{CellIterator, Dirty, RowIterator, Snapshot},
    screen::CellWide,
    terminal::{Options, Terminal},
};

pub trait Screen {
    /// Feed raw PTY output bytes into the emulator.
    fn write(&mut self, data: &[u8]);
    fn resize(&mut self, rows: u16, cols: u16);
    /// Full screen contents; also clears dirty state.
    fn snapshot(&mut self) -> Frame;
    /// Rows changed since the last `snapshot`/`diff`, or `None` if clean.
    fn diff(&mut self) -> Option<Frame>;
    /// Serialize the current terminal state (content incl. scrollback,
    /// styles, cursor, modes) as a VT escape stream: replaying it into a
    /// fresh emulator reproduces the screen. Powers `bytes`-mode attach.
    fn vt_dump(&mut self) -> Vec<u8>;
}

pub struct GhosttyScreen {
    term: Terminal<'static, 'static>,
    state: RenderState<'static>,
    rows_iter: RowIterator<'static>,
    cells_iter: CellIterator<'static>,
}

// SAFETY: libghostty-vt types are !Send because the underlying library is
// not thread-safe, not because they hold thread-local state. A GhosttyScreen
// is confined to its session's VT thread; `Session` moves it there once and
// never shares it. TODO(M2): replace with a thread-confinement wrapper type.
unsafe impl Send for GhosttyScreen {}

impl GhosttyScreen {
    pub fn new(rows: u16, cols: u16, max_scrollback: usize) -> anyhow::Result<Self> {
        Ok(Self {
            term: Terminal::new(Options {
                cols,
                rows,
                max_scrollback,
            })
            .map_err(|e| anyhow::anyhow!("create terminal: {e:?}"))?,
            state: RenderState::new().map_err(|e| anyhow::anyhow!("render state: {e:?}"))?,
            rows_iter: RowIterator::new().map_err(|e| anyhow::anyhow!("row iter: {e:?}"))?,
            cells_iter: CellIterator::new().map_err(|e| anyhow::anyhow!("cell iter: {e:?}"))?,
        })
    }

    /// Read rows out of a snapshot. `only_dirty` selects diff vs full reads.
    /// Clears row dirty flags as it goes.
    fn collect_rows(
        rows_iter: &mut RowIterator<'static>,
        cells_iter: &mut CellIterator<'static>,
        snap: &Snapshot<'static, '_>,
        only_dirty: bool,
    ) -> Vec<RowData> {
        let mut lines = Vec::new();
        let mut y: u16 = 0;
        let Ok(mut rows) = rows_iter.update(snap) else {
            return lines;
        };
        while let Some(row) = rows.next() {
            let dirty = row.dirty().unwrap_or(true);
            if dirty {
                let _ = row.set_dirty(false);
            }
            if only_dirty && !dirty {
                y += 1;
                continue;
            }
            let mut cells = Vec::new();
            if let Ok(mut cs) = cells_iter.update(row) {
                let mut text = String::new();
                while let Some(cell) = cs.next() {
                    let mut fl: u8 = 0;
                    let spacer = matches!(
                        cell.raw_cell().and_then(|c| c.wide()),
                        Ok(CellWide::SpacerTail | CellWide::SpacerHead)
                    );
                    text.clear();
                    if spacer {
                        fl |= cellflags::WIDE_SPACER;
                    } else {
                        let _ = cell.graphemes_utf8(&mut text);
                    }
                    if let Ok(style) = cell.style() {
                        if style.bold {
                            fl |= cellflags::BOLD;
                        }
                        if style.italic {
                            fl |= cellflags::ITALIC;
                        }
                        if !matches!(style.underline, libghostty_vt::style::Underline::None) {
                            fl |= cellflags::UNDERLINE;
                        }
                        if style.inverse {
                            fl |= cellflags::INVERSE;
                        }
                        if style.faint {
                            fl |= cellflags::FAINT;
                        }
                        if style.strikethrough {
                            fl |= cellflags::STRIKETHROUGH;
                        }
                    }
                    cells.push(CellData {
                        t: text.clone(),
                        fg: cell.fg_color().ok().flatten().map(|c| [c.r, c.g, c.b]),
                        bg: cell.bg_color().ok().flatten().map(|c| [c.r, c.g, c.b]),
                        fl,
                    });
                }
            }
            lines.push(RowData { y, cells });
            y += 1;
        }
        lines
    }

    fn cursor(snap: &Snapshot<'static, '_>) -> Cursor {
        let visible = snap.cursor_visible().unwrap_or(false);
        match snap.cursor_viewport().ok().flatten() {
            Some(c) => Cursor {
                x: c.x,
                y: c.y,
                visible,
            },
            None => Cursor {
                x: 0,
                y: 0,
                visible: false,
            },
        }
    }
}

impl Screen for GhosttyScreen {
    fn write(&mut self, data: &[u8]) {
        self.term.vt_write(data);
    }

    fn resize(&mut self, rows: u16, cols: u16) {
        let _ = self.term.resize(cols, rows, 0, 0);
    }

    fn snapshot(&mut self) -> Frame {
        let (rows, cols) = (self.term.rows().unwrap_or(0), self.term.cols().unwrap_or(0));
        match self.state.update(&self.term) {
            Ok(snap) => {
                let _ = snap.set_dirty(Dirty::Clean);
                let lines =
                    Self::collect_rows(&mut self.rows_iter, &mut self.cells_iter, &snap, false);
                let cursor = Self::cursor(&snap);
                Frame::Snapshot {
                    rows,
                    cols,
                    lines,
                    cursor,
                }
            }
            Err(_) => Frame::Snapshot {
                rows,
                cols,
                lines: Vec::new(),
                cursor: Cursor {
                    x: 0,
                    y: 0,
                    visible: false,
                },
            },
        }
    }

    fn vt_dump(&mut self) -> Vec<u8> {
        let opts = FormatterOptions::new()
            .with_format(Format::Vt)
            .with_modes(true)
            .with_scrolling_region(true)
            .with_tabstops(true)
            .with_keyboard(true)
            .with_cursor(true)
            .with_style(true)
            .with_hyperlink(true)
            .with_kitty_keyboard(true)
            .with_charsets(true);
        match Formatter::new(&self.term, opts) {
            Ok(mut f) => match f.format_alloc(None) {
                Ok(bytes) => bytes.to_vec(),
                Err(e) => {
                    tracing::warn!("vt dump format failed: {e:?}");
                    Vec::new()
                }
            },
            Err(e) => {
                tracing::warn!("vt dump formatter init failed: {e:?}");
                Vec::new()
            }
        }
    }

    fn diff(&mut self) -> Option<Frame> {
        let snap = self.state.update(&self.term).ok()?;
        let dirty = snap.dirty().ok()?;
        match dirty {
            Dirty::Clean => None,
            Dirty::Partial => {
                let _ = snap.set_dirty(Dirty::Clean);
                let lines =
                    Self::collect_rows(&mut self.rows_iter, &mut self.cells_iter, &snap, true);
                let cursor = Self::cursor(&snap);
                if lines.is_empty() {
                    // Cursor-only change.
                    Some(Frame::Diff { lines, cursor })
                } else {
                    Some(Frame::Diff { lines, cursor })
                }
            }
            Dirty::Full => {
                let _ = snap.set_dirty(Dirty::Clean);
                let lines =
                    Self::collect_rows(&mut self.rows_iter, &mut self.cells_iter, &snap, false);
                let cursor = Self::cursor(&snap);
                let (rows, cols) = (snap.rows().unwrap_or(0), snap.cols().unwrap_or(0));
                Some(Frame::Snapshot {
                    rows,
                    cols,
                    lines,
                    cursor,
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scroll_case(nlines: usize, scrollback: usize) {
        eprintln!("--- case: {nlines} lines, {scrollback} scrollback");
        let mut s = GhosttyScreen::new(24, 80, scrollback).unwrap();
        let mut data = String::new();
        for i in 0..nlines {
            data.push_str(&format!("{i}\r\n"));
        }
        let t0 = std::time::Instant::now();
        s.write(data.as_bytes());
        eprintln!("write done in {:?}", t0.elapsed());
        let t1 = std::time::Instant::now();
        let frame = s.snapshot();
        let snapped = t1.elapsed();
        let Frame::Snapshot { lines, rows, .. } = frame else {
            panic!("expected snapshot")
        };
        eprintln!(
            "snapshot in {snapped:?}, lines: {} (rows={rows})",
            lines.len()
        );
        assert_eq!(
            lines.len(),
            rows as usize,
            "snapshot must be viewport-sized"
        );
        assert!(snapped.as_secs() < 2, "snapshot too slow: {snapped:?}");
    }

    #[test]
    fn vt_dump_replays_into_identical_screen() {
        let mut s = GhosttyScreen::new(5, 20, 100).unwrap();
        s.write(b"\x1b[31mhello\x1b[0m world\r\nline2\r\n");
        let dump = s.vt_dump();
        assert!(!dump.is_empty());

        let mut replay = GhosttyScreen::new(5, 20, 100).unwrap();
        replay.write(&dump);
        let (a, b) = (s.snapshot(), replay.snapshot());
        let row_text = |f: &Frame, y: usize| -> String {
            let Frame::Snapshot { lines, .. } = f else {
                panic!("expected snapshot")
            };
            lines[y]
                .cells
                .iter()
                .map(|c| if c.t.is_empty() { " " } else { c.t.as_str() })
                .collect()
        };
        assert!(row_text(&a, 0).starts_with("hello world"));
        for y in 0..3 {
            assert_eq!(row_text(&a, y), row_text(&b, y), "row {y} differs");
        }
    }

    #[test]
    fn snapshot_bounded_after_heavy_scrollback() {
        scroll_case(1_000, 0);
        scroll_case(1_000, 10_000);
        scroll_case(20_000, 10_000);
        scroll_case(100_000, 10_000);
    }
}
