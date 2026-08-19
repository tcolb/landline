// Raw keyboard input for the terminal: a bare view adopting UIKeyInput.
//
// The system keyboard calls insertText(_:)/deleteBackward() once per
// keystroke — including every auto-repeat tick at every acceleration
// stage — which is the primitive a terminal needs. The TextInput-based
// approach (hidden field + content diffing) fought iOS text intelligence
// (async resets, word-deletion acceleration, boundary heuristics) and
// lost repeatedly; this removes the text field entirely.

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

class KeyInputView: ExpoView, UIKeyInput {
  let onInsertText = EventDispatcher()
  let onDeleteBackward = EventDispatcher()

  override var canBecomeFirstResponder: Bool { true }

  // UIKeyInput. hasText must be true or iOS suppresses delete events on an
  // "empty" input — the exact failure mode the old approach cushioned
  // around with zero-width spaces.
  var hasText: Bool { true }

  func insertText(_ text: String) {
    onInsertText(["text": text])
  }

  func deleteBackward() {
    onDeleteBackward([:])
  }

  // UITextInputTraits: terminal-appropriate keyboard behavior.
  var keyboardAppearance: UIKeyboardAppearance = .dark
  var keyboardType: UIKeyboardType = .default
  var returnKeyType: UIReturnKeyType = .default
  var autocorrectionType: UITextAutocorrectionType = .no
  var autocapitalizationType: UITextAutocapitalizationType = .none
  var spellCheckingType: UITextSpellCheckingType = .no
  var smartQuotesType: UITextSmartQuotesType = .no
  var smartDashesType: UITextSmartDashesType = .no
  var smartInsertDeleteType: UITextSmartInsertDeleteType = .no

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
