/**
 * Driving Settings from a probe (`settings-sections` design D10).
 *
 * Settings is a dialog with a list of sections; every change applies when it is made, so there is no Save to
 * press. These helpers take the user's path: a real click on the activity bar entry and on a section, a typed
 * value followed by Enter. Going through `window.workspace.settings.*` instead would bypass
 * `PreferencesProvider`, and the renderer's state would not follow (a lesson `probe:terminal` paid for).
 */
import { pollFor } from './instrument.mjs'
import { copy, label } from './copy.mjs'

export const SETTINGS_DIALOG = `[role="dialog"]${label('settings.title')}`
const SECTION_LIST = `${SETTINGS_DIALOG} [role="tablist"]${label('settings.sections.label')}`

/** The selector of an element inside Settings. */
export const inSettings = (selector) => `${SETTINGS_DIALOG} ${selector}`

const rectOf = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return null
  el.scrollIntoView({ block: 'nearest' })
  const r = el.getBoundingClientRect()
  return r.width === 0 || r.height === 0 ? null : { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})()`

/** A real left click at the centre of the element the selector names, measured right before the click. */
export async function clickSelector(client, selector, what = selector) {
  const at = await pollFor({
    read: () => client.evaluate(rectOf(selector)),
    settled: (value) => value !== null,
    timeoutMs: 5_000,
    label: `find ${what}`,
  })
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', {
      type,
      x: at.x,
      y: at.y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: 1,
    })
  }
}

/**
 * Opens Settings from the activity bar, then shows `section` (`general`, `terminal`, `agents`, `integrations`,
 * `remote`, `about`) unless it is already shown. Resolves once that section's tab is selected.
 */
export async function openSettings(client, section) {
  const open = await client.evaluate(`Boolean(document.querySelector(${JSON.stringify(SETTINGS_DIALOG)}))`)
  if (!open) {
    await clickSelector(
      client,
      `nav${label('activityBar.label')} button${label('activityBar.settings')}`,
      'the Settings entry',
    )
  }
  await showSection(client, section)
}

/** Shows a section of the open Settings. */
export async function showSection(client, section) {
  const tab = `${SECTION_LIST} [role="tab"]`
  const name = copy(`settings.sections.${section}`)
  const tabSelector = `${tab}[id="settings-tab-${section}"]`
  await pollFor({
    read: () => client.evaluate(`Boolean(document.querySelector(${JSON.stringify(tabSelector)}))`),
    settled: Boolean,
    timeoutMs: 5_000,
    label: `Settings shows its section list (${name})`,
  })
  const selected = await client.evaluate(
    `document.querySelector(${JSON.stringify(tabSelector)})?.getAttribute('aria-selected') === 'true'`,
  )
  if (!selected) await clickSelector(client, tabSelector, `the ${name} section`)
  await pollFor({
    read: () =>
      client.evaluate(`document.querySelector(${JSON.stringify(tabSelector)})?.getAttribute('aria-selected') === 'true'`),
    settled: Boolean,
    timeoutMs: 5_000,
    label: `the ${name} section is shown`,
  })
}

/** Closes Settings with its close control and waits for it to be gone. */
export async function closeSettings(client) {
  await clickSelector(client, inSettings(`button${label('common.close')}`), 'the Settings close control')
  await pollFor({
    read: () => client.evaluate(`document.querySelector(${JSON.stringify(SETTINGS_DIALOG)}) === null`),
    settled: Boolean,
    timeoutMs: 5_000,
    label: 'Settings is closed',
  })
}

/**
 * Types `value` into the Settings field labelled by `labelKey` (a dictionary key), replacing its text, and
 * optionally presses Enter (`commit`: 'enter'), moves focus away (`commit`: 'blur'), or leaves the edit
 * unapplied (`commit`: 'none').
 *
 * React controlled inputs ignore a plain `value =`: the native setter plus an `input` event is what reaches
 * `onChange`. Enter goes through CDP with its real key code, which is what the field's handler reads.
 */
export async function setField(client, labelKey, value, { commit = 'enter' } = {}) {
  const selector = inSettings(`input${label(labelKey)}`)
  const found = await client.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    if (!input) return false
    input.focus()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(String(value))})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  if (!found) throw new Error(`Settings has no field labelled ${copy(labelKey)}`)
  if (commit === 'enter') {
    for (const type of ['keyDown', 'keyUp']) {
      await client.send('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        ...(type === 'keyDown' ? { text: '\r' } : {}),
      })
    }
  } else if (commit === 'blur') {
    await client.evaluate(`document.querySelector(${JSON.stringify(selector)})?.blur()`)
  }
}

/** Presses Esc on the focused element (a field, a confirmation, or Settings itself). */
export async function pressEscape(client) {
  for (const type of ['keyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', {
      type,
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    })
  }
}

/** Polls `expression` until `settled` holds: a change applies asynchronously, through the main process. */
export function awaitApplied(client, expression, settled, what, timeoutMs = 5_000) {
  return pollFor({ read: () => client.evaluate(expression), settled, timeoutMs, label: what })
}

/**
 * Chooses `value` in the Settings `<select>` labelled by `labelKey`. React listens for `change` on a select; the
 * native setter is what makes React see the new value (as `setField` does for inputs).
 */
export async function setSelect(client, labelKey, value) {
  const selector = inSettings(`select${label(labelKey)}`)
  const found = await client.evaluate(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)})
    if (!select) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(select, ${JSON.stringify(String(value))})
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  if (!found) throw new Error(`Settings has no select labelled ${copy(labelKey)}`)
}

/** The value of the Settings `<select>` labelled by `labelKey`, or `null` when there is none. */
export const selectValue = (labelKey) =>
  `document.querySelector(${JSON.stringify(inSettings(`select${label(labelKey)}`))})?.value ?? null`
