// Raw keyboard input for the terminal via full UITextInput conformance.
//
// UIKeyInput alone delivers insertText/deleteBackward, but the system
// keyboard's delete AUTO-REPEAT is driven by UIKit's text machinery and
// only engages for UITextInput implementers. So the view maintains a small
// fake document (a padded buffer, replenished synchronously — no async
// races possible, unlike the retired JS-side sentinel) and implements the
// protocol over it. The JS contract is unchanged: one onInsertText /
// onDeleteBackward event per keystroke, auto-repeat included. Marked text
// (IME composition, dictation) commits as a single insert.

import ExpoModulesCore
import UIKit

public class KeyInputModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LandlineKeyInput")

    View(KeyInputView.self) {
      Events("onInsertText", "onDeleteBackward")

      Prop("focused") { (view: KeyInputView, focused: Bool) in
        view.setFocused(focused)
      }

      // Edge-triggered focus: increments re-request the keyboard even when
      // `focused` never changed (level props can't re-fire).
      Prop("focusNonce") { (view: KeyInputView, nonce: Int) in
        if nonce > 0 {
          view.setFocused(true)
        }
      }
    }
  }
}

/// Index-based UITextPosition over the fake document (UTF-16 offsets).
final class KIPosition: UITextPosition {
  let index: Int
  init(_ index: Int) {
    self.index = index
  }
}

final class KIRange: UITextRange {
  let startIndex: Int
  let endIndex: Int
  init(_ start: Int, _ end: Int) {
    self.startIndex = min(start, end)
    self.endIndex = max(start, end)
  }
  override var start: UITextPosition { KIPosition(startIndex) }
  override var end: UITextPosition { KIPosition(endIndex) }
  override var isEmpty: Bool { startIndex == endIndex }
}

class KeyInputView: ExpoView, UITextInput {
  let onInsertText = EventDispatcher()
  let onDeleteBackward = EventDispatcher()

  override var canBecomeFirstResponder: Bool { true }

  // MARK: - Fake document

  /// Backing store UIKit operates on. Kept non-empty by synchronous
  /// replenishment so delete always has material and repeat never stalls.
  private var storage: NSMutableString = NSMutableString(string: KeyInputView.padding)
  private static let padding = String(repeating: " ", count: 256)
  private var markedRange: NSRange? = nil

  private var docLength: Int { storage.length }

  private func replenishIfNeeded() {
    if storage.length < 32 {
      storage.insert(KeyInputView.padding, at: 0)
      if let m = markedRange {
        markedRange = NSRange(location: m.location + (KeyInputView.padding as NSString).length, length: m.length)
      }
    }
    if storage.length > 8192 {
      storage.deleteCharacters(in: NSRange(location: 0, length: storage.length - 4096))
      markedRange = nil
    }
  }

  private func mutate(_ body: () -> Void) {
    inputDelegate?.textWillChange(self)
    body()
    replenishIfNeeded()
    inputDelegate?.textDidChange(self)
  }

  // MARK: - UIKeyInput

  var hasText: Bool { true }

  func insertText(_ text: String) {
    mutate {
      storage.append(text)
    }
    onInsertText(["text": text])
  }

  func deleteBackward() {
    mutate {
      if storage.length > 0 {
        storage.deleteCharacters(in: NSRange(location: storage.length - 1, length: 1))
      }
    }
    onDeleteBackward([:])
  }

  // MARK: - UITextInput core

  weak var inputDelegate: UITextInputDelegate?

  lazy var tokenizer: UITextInputTokenizer = UITextInputStringTokenizer(textInput: self)

  var beginningOfDocument: UITextPosition { KIPosition(0) }
  var endOfDocument: UITextPosition { KIPosition(docLength) }

  /// Caret pinned to end-of-document unconditionally: terminal input has
  /// no cursor-within-field concept, and a caret UIKit believes sits at
  /// position 0 would suppress delete (nothing before it to remove).
  var selectedTextRange: UITextRange? {
    get { KIRange(docLength, docLength) }
    set { /* end-pinned; ignore */ }
  }

  var markedTextRange: UITextRange? {
    guard let m = markedRange else { return nil }
    return KIRange(m.location, m.location + m.length)
  }

  var markedTextStyle: [NSAttributedString.Key: Any]? = nil

  func text(in range: UITextRange) -> String? {
    guard let r = range as? KIRange else { return nil }
    let lo = max(0, min(r.startIndex, docLength))
    let hi = max(lo, min(r.endIndex, docLength))
    return storage.substring(with: NSRange(location: lo, length: hi - lo))
  }

  func replace(_ range: UITextRange, withText text: String) {
    guard let r = range as? KIRange else { return }
    let lo = max(0, min(r.startIndex, docLength))
    let hi = max(lo, min(r.endIndex, docLength))
    let deleted = hi - lo
    mutate {
      storage.replaceCharacters(in: NSRange(location: lo, length: hi - lo), with: text)
    }
    // Only tail edits map onto a terminal line; emit deletes for what was
    // replaced, then the replacement (autocorrect-style delete+retype).
    for _ in 0..<deleted {
      onDeleteBackward([:])
    }
    if !text.isEmpty {
      onInsertText(["text": text])
    }
  }

  // MARK: - Marked text (IME composition / dictation)

  func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
    let text = markedText ?? ""
    mutate {
      if let m = markedRange {
        storage.replaceCharacters(in: m, with: text)
        markedRange = NSRange(location: m.location, length: (text as NSString).length)
      } else {
        markedRange = NSRange(location: storage.length, length: (text as NSString).length)
        storage.append(text)
      }
    }
  }

  func unmarkText() {
    guard let m = markedRange else { return }
    let committed = storage.substring(with: m)
    markedRange = nil
    if !committed.isEmpty {
      onInsertText(["text": committed])
    }
  }

  // MARK: - Positions and ranges

  func textRange(from fromPosition: UITextPosition, to toPosition: UITextPosition) -> UITextRange? {
    guard let a = fromPosition as? KIPosition, let b = toPosition as? KIPosition else { return nil }
    return KIRange(a.index, b.index)
  }

  func position(from position: UITextPosition, offset: Int) -> UITextPosition? {
    guard let p = position as? KIPosition else { return nil }
    let i = p.index + offset
    if i < 0 || i > docLength { return nil }
    return KIPosition(i)
  }

  func position(from position: UITextPosition, in direction: UITextLayoutDirection, offset: Int) -> UITextPosition? {
    switch direction {
    case .left, .up:
      return self.position(from: position, offset: -offset)
    default:
      return self.position(from: position, offset: offset)
    }
  }

  func compare(_ position: UITextPosition, to other: UITextPosition) -> ComparisonResult {
    guard let a = position as? KIPosition, let b = other as? KIPosition else { return .orderedSame }
    if a.index < b.index { return .orderedAscending }
    if a.index > b.index { return .orderedDescending }
    return .orderedSame
  }

  func offset(from: UITextPosition, to toPosition: UITextPosition) -> Int {
    guard let a = from as? KIPosition, let b = toPosition as? KIPosition else { return 0 }
    return b.index - a.index
  }

  func position(within range: UITextRange, farthestIn direction: UITextLayoutDirection) -> UITextPosition? {
    guard let r = range as? KIRange else { return nil }
    switch direction {
    case .left, .up:
      return KIPosition(r.startIndex)
    default:
      return KIPosition(r.endIndex)
    }
  }

  func characterRange(byExtending position: UITextPosition, in direction: UITextLayoutDirection) -> UITextRange? {
    guard let p = position as? KIPosition else { return nil }
    switch direction {
    case .left, .up:
      return KIRange(max(0, p.index - 1), p.index)
    default:
      return KIRange(p.index, min(docLength, p.index + 1))
    }
  }

  // MARK: - Writing direction / geometry (invisible view: trivial answers)

  func baseWritingDirection(for position: UITextPosition, in direction: UITextStorageDirection) -> NSWritingDirection {
    .leftToRight
  }

  func setBaseWritingDirection(_ writingDirection: NSWritingDirection, for range: UITextRange) {}

  func firstRect(for range: UITextRange) -> CGRect { .zero }

  func caretRect(for position: UITextPosition) -> CGRect {
    CGRect(x: 0, y: 0, width: 2, height: 1)
  }

  func selectionRects(for range: UITextRange) -> [UITextSelectionRect] { [] }

  func closestPosition(to point: CGPoint) -> UITextPosition? { KIPosition(docLength) }

  func closestPosition(to point: CGPoint, within range: UITextRange) -> UITextPosition? {
    (range as? KIRange).map { KIPosition($0.endIndex) }
  }

  func characterRange(at point: CGPoint) -> UITextRange? {
    KIRange(max(0, docLength - 1), docLength)
  }

  // MARK: - UITextInputTraits: terminal-appropriate keyboard behavior.

  var keyboardAppearance: UIKeyboardAppearance = .dark
  var keyboardType: UIKeyboardType = .default
  var returnKeyType: UIReturnKeyType = .default
  var autocorrectionType: UITextAutocorrectionType = .no
  var autocapitalizationType: UITextAutocapitalizationType = .none
  var spellCheckingType: UITextSpellCheckingType = .no
  var smartQuotesType: UITextSmartQuotesType = .no
  var smartDashesType: UITextSmartDashesType = .no
  var smartInsertDeleteType: UITextSmartInsertDeleteType = .no

  // MARK: - Focus

  // becomeFirstResponder silently fails before the view joins a window
  // (exactly when the mount-time prop applies); remember intent and retry
  // on window attach.
  private var wantsFocus = false

  func setFocused(_ focused: Bool) {
    wantsFocus = focused
    DispatchQueue.main.async {
      if focused {
        if self.window != nil {
          self.becomeFirstResponder()
        }
      } else {
        self.resignFirstResponder()
      }
    }
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if wantsFocus && window != nil {
      DispatchQueue.main.async {
        self.becomeFirstResponder()
      }
    }
  }
}
