/**
 * Whether keyboard focus is nowhere: on `<body>`, or on nothing at all. A launch arrival focuses its session's
 * input only then (`restore-running-sessions` D3).
 *
 * **Why this and not "focus was on its Wake button"**: removing a focused element blurs it synchronously
 * (measured in this repo's Electron), and the Wake button is removed in the very commit that makes the session
 * running — by the time an arrival effect runs, focus has already fallen to `<body>`. So the button's focus cannot
 * be observed there; that focus now goes nowhere can, and it is what matters (typing would reach nothing).
 */
export function focusIsNowhere(): boolean {
  const active = document.activeElement
  return active === null || active === document.body
}
