// What a press on the control that opens a popup means. Pure: no herdr import
// (popup-press.test.mjs).
//
// Herdr closes a popup on a press outside it and hands that same press to what lies under the
// pointer. On the control that opened the popup, the press closes it and must open nothing: a
// popup opened by the press that closes another gets no answer to the read its init starts
// (docs/herdr-mod-platform.md).

// The popup's answer may reach the opener just before the press that closed it does. A press
// this soon (ms) after the answer is that press.
export const SAME_PRESS = 200;

// popupPress({ now? }) → {
//   opened() → shown   a popup was opened
//   closed(shown)      that popup's answer came
//   opens() → bool     a press on the control: true when it should open the popup, false when
//                      it is the press that closes it. Asked once per press: a popup whose
//                      answer never comes costs one press, and the next one opens.
// }
export function popupPress({ now = Date.now } = {}) {
  let turn = 0, showing = null, closedAt = -Infinity;
  return {
    opened() { showing = ++turn; closedAt = -Infinity; return showing; },
    closed(shown) {
      if (shown !== showing) return;
      showing = null;
      closedAt = now();
    },
    opens() {
      const closing = showing !== null || now() - closedAt < SAME_PRESS;
      showing = null;
      closedAt = -Infinity;
      return !closing;
    },
  };
}
