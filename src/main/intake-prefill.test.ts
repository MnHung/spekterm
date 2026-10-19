import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { configureAgentEvents, prepareEventInjection } from './agent-events'
import { clearWait } from './agent-wait'
import {
  cancelPrefill,
  forgetSubmission,
  hasUnconfirmedSubmission,
  isSubmitted,
  notePrefillKey,
  onPrefillChange,
  pendingPrefillCount,
  prefillModeFor,
  prefillOf,
  schedulePrefill,
  SUBMIT_CONFIRM_MS,
  SUBMIT_KEY,
  SUBMIT_KEY_DELAY_MS,
  watchSubmission,
} from './intake-prefill'
import { forgetInput, noteWrite } from './pty-input'

const bases: string[] = []
after(() => {
  for (const base of bases) fs.rmSync(base, { recursive: true, force: true })
})

function configure(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-prefill-'))
  bases.push(base)
  configureAgentEvents(base)
  return base
}

function fire(base: string, sessionId: string, body: Record<string, unknown>): void {
  const dir = path.join(base, 'agent-events', sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${process.hrtime.bigint()}-x.json`)
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(body))
  fs.renameSync(`${file}.tmp`, file)
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`timed out waiting for: ${label}`)
}

describe('預填不早於就緒', () => {
  it('未就緒之前的整段期間都沒有寫入；就緒之後恰寫一次', async () => {
    // **對照組**：把觸發改成「pty 建立完成之後、不等待就緒即寫入」→ 前半必須變紅。
    // （不可用「建立後立即寫入」當 mutation —— 那時 pty 可能還不存在，寫入會被丟棄，
    //  mutant 什麼都沒做而對照組保持綠。）
    const base = configure()
    const sessionId = 'P1'
    prepareEventInjection(sessionId, true)

    const writes: string[] = []
    schedulePrefill(sessionId, 'do the thing', {
      write: (_id, data) => writes.push(data),
      onTimeout: () => assert.fail('不該逾時'),
    })

    // 逐一餵入非就緒的狀態，每一步都斷言「仍然為空」。
    for (const [name, body] of [
      ['busy', { hook_event_name: 'PreToolUse' }],
      ['awaiting-choice', { hook_event_name: 'PermissionRequest' }],
      ['unknown', { hook_event_name: 'SessionEnd' }],
    ] as const) {
      fire(base, sessionId, body)
      await new Promise((resolve) => setTimeout(resolve, 600))
      assert.deepEqual(writes, [], `${name} 時不得寫入`)
    }

    fire(base, sessionId, { hook_event_name: 'SessionStart' })
    await waitFor('就緒後寫入', () => writes.length === 1)

    // 再次就緒不得重複寫入 —— 否則使用者正在打字時會被插進第二份 prompt。
    fire(base, sessionId, { hook_event_name: 'Stop' })
    await new Promise((resolve) => setTimeout(resolve, 800))
    assert.equal(writes.length, 1)

    assert.equal(writes[0], 'do the thing')
    assert.equal(writes[0].includes('\r'), false, '不得附送出字元')
    clearWait(sessionId)
  })

  it('已經就緒時立刻寫 —— 那不是「太早」', async () => {
    const base = configure()
    const sessionId = 'P2'
    prepareEventInjection(sessionId, true)

    const writes: string[] = []
    const off = { done: false }
    schedulePrefill(sessionId, 'first', {
      write: (_id, data) => writes.push(data),
      onTimeout: () => assert.fail('不該逾時'),
      onFilled: () => {
        off.done = true
      },
    })
    fire(base, sessionId, { hook_event_name: 'SessionStart' })
    await waitFor('第一次填入', () => writes.length === 1)

    // 狀態已是 ready，第二次排定應立刻寫。
    schedulePrefill(sessionId, 'second', {
      write: (_id, data) => writes.push(data),
      onTimeout: () => assert.fail('不該逾時'),
    })
    assert.equal(writes.length, 2)
    clearWait(sessionId)
  })

  it('多行的 prompt 被編碼器壓成單行', async () => {
    const base = configure()
    const sessionId = 'P3'
    prepareEventInjection(sessionId, true)
    const writes: string[] = []
    schedulePrefill(sessionId, 'line one\nline two', {
      write: (_id, data) => writes.push(data),
      onTimeout: () => assert.fail('不該逾時'),
    })
    fire(base, sessionId, { hook_event_name: 'SessionStart' })
    await waitFor('填入', () => writes.length === 1)
    assert.equal(writes[0].includes('\n'), false)
    clearWait(sessionId)
  })
})

describe('等不到就緒', () => {
  it('逾時之後說話，並讓該則回到可重新處理的狀態', async () => {
    // 判準**以狀態為準，不以成因為準** —— 事件回報未啟用只是其中一種成因。
    const base = configure()
    const sessionId = 'P4'
    // 刻意不注入事件：等待狀態恆為未知。
    void base

    let timedOut = false
    schedulePrefill(sessionId, 'x', {
      write: () => assert.fail('不該寫入'),
      onTimeout: () => {
        timedOut = true
      },
    })

    // 以取消模擬逾時的清理路徑，並直接驗證計時器的存在（不睡 30 秒）。
    assert.equal(pendingPrefillCount(), 1)
    cancelPrefill(sessionId)
    assert.equal(pendingPrefillCount(), 0)
    assert.equal(timedOut, false, '取消不是逾時')
    clearWait(sessionId)
  })

  it('事件回報未啟用時，等待狀態恆為未知 —— 預填永遠不會發生', async () => {
    configure()
    const sessionId = 'P5'
    // `prepareEventInjection(sessionId, false)` ⇒ 不參與 ⇒ 事件目錄不存在。
    assert.equal(prepareEventInjection(sessionId, false), null)

    const writes: string[] = []
    schedulePrefill(sessionId, 'x', {
      write: (_id, data) => writes.push(data),
      onTimeout: () => undefined,
    })
    await new Promise((resolve) => setTimeout(resolve, 900))
    assert.deepEqual(writes, [])
    cancelPrefill(sessionId)
    clearWait(sessionId)
  })
})

describe('已送出的判定（intake-inbox-usability）', () => {
  it('等待狀態落回未知不視為已送出', () => {
    // 判定的後果會落盤（已了結 ⇒ 從收件匣移除本文）—— 無法分辨的狀態不得推定為送出。
    assert.equal(isSubmitted('unknown'), false)
    assert.equal(isSubmitted('ready'), false)
    // 對照：真正開始工作的兩種狀態為真，否則上面兩條對「永遠回 false」也成立。
    assert.equal(isSubmitted('busy'), true)
    assert.equal(isSubmitted('awaiting-choice'), true)
  })
})

describe('要不要代為送出（handoff-session-lifecycle）', () => {
  it('非第三方本文、新建的 session ⇒ 送出；其餘一律只填入', () => {
    assert.equal(prefillModeFor({ firstPartyBody: true, reusedSession: false }), 'submit')
    assert.equal(prefillModeFor({ firstPartyBody: false, reusedSession: false }), 'fill')
    // **沿用既有 session 一律只填入** —— 使用者可能已經在裡面打了字。
    assert.equal(prefillModeFor({ firstPartyBody: true, reusedSession: true }), 'fill')
    assert.equal(prefillModeFor({ firstPartyBody: false, reusedSession: true }), 'fill')
  })

  it('schedulePrefill 以送出模式寫入時，就緒後寫下的內容以送出字元結尾', async () => {
    const base = configure()
    const sessionId = 'S-SUBMIT'
    prepareEventInjection(sessionId, true)
    const writes: { data: string; at: number }[] = []
    schedulePrefill(
      sessionId,
      'do the thing',
      { write: (_id, data) => writes.push({ data, at: Date.now() }), onTimeout: () => assert.fail('不該逾時') },
      'submit',
    )
    fire(base, sessionId, { hook_event_name: 'SessionStart' })
    await waitFor('寫入', () => writes.length >= 2, SUBMIT_KEY_DELAY_MS + 5000)
    // **文字與送出字元分兩次寫，而且隔開** —— 長文字一次抵達被當成貼上，緊跟在後的送出字元被併進去
    // 成為換行（實測：隔 50、100ms 仍失敗）。對照組：兩者併寫、或分開但不等（`submit-joined`）→ 必須變紅。
    assert.deepEqual(writes.map((w) => w.data), ['do the thing', SUBMIT_KEY])
    assert.ok(writes[1].at - writes[0].at >= SUBMIT_KEY_DELAY_MS - 20, `間隔 ${writes[1].at - writes[0].at}ms`)
    clearWait(sessionId)
  })

  it('只填入模式不寫送出字元', async () => {
    const base = configure()
    const sessionId = 'S-FILL'
    prepareEventInjection(sessionId, true)
    const writes: string[] = []
    schedulePrefill(sessionId, 'line one\nline two', { write: (_id, data) => writes.push(data), onTimeout: () => assert.fail('不該逾時') })
    fire(base, sessionId, { hook_event_name: 'SessionStart' })
    await waitFor('寫入', () => writes.length > 0)
    await new Promise((resolve) => setTimeout(resolve, SUBMIT_KEY_DELAY_MS + 200))
    assert.deepEqual(writes, ['line oneline two'])
    clearWait(sessionId)
  })
})

describe('送出之後的監看（watchSubmission）', () => {
  type Sub = (snapshot: { state: 'ready' | 'busy' | 'awaiting-choice' | 'unknown' }) => void
  function harness() {
    const subs: Sub[] = []
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
    const deps = {
      subscribe: (_id: string, fn: Sub) => {
        subs.push(fn)
        return () => {
          const i = subs.indexOf(fn)
          if (i >= 0) subs.splice(i, 1)
        }
      },
      setTimer: (fn: () => void, ms: number) => {
        const t = { fn, ms, cleared: false }
        timers.push(t)
        return t
      },
      clearTimer: (handle: unknown) => {
        ;(handle as { cleared: boolean }).cleared = true
      },
    }
    const emit = (state: 'ready' | 'busy' | 'awaiting-choice' | 'unknown'): void => {
      for (const fn of [...subs]) fn({ state })
    }
    return { subs, timers, deps, emit }
  }

  it('只填入：立刻呈現待送出；開始工作後視為送出並結束監看', () => {
    const h = harness()
    const calls: string[] = []
    watchSubmission('S', 'fill', { onPending: () => calls.push('pending'), onSubmitted: () => calls.push('sent') }, h.deps)
    assert.deepEqual(calls, ['pending'])
    h.emit('unknown')
    assert.deepEqual(calls, ['pending'], '落回未知不算送出')
    h.emit('busy')
    assert.deepEqual(calls, ['pending', 'sent'])
    assert.equal(h.subs.length, 0, '送出之後退訂')
  })

  it('送出：上限時間內見到開始工作 ⇒ 不呈現待送出', () => {
    const h = harness()
    const calls: string[] = []
    watchSubmission('S', 'submit', { onPending: () => calls.push('pending'), onSubmitted: () => calls.push('sent') }, h.deps)
    assert.deepEqual(calls, [], '送出時不立刻呈現待送出')
    assert.equal(h.timers[0].ms, SUBMIT_CONFIRM_MS)
    h.emit('busy')
    assert.deepEqual(calls, ['sent'])
    assert.equal(h.timers[0].cleared, true, '送出之後計時器被清掉')
  })

  it('送出：上限時間內沒見到開始工作 ⇒ 退回待送出，其後使用者送出仍了結', () => {
    // **對照組**：把退路拿掉（`setTimer` 那行改成不排程）→ 這條的第一個斷言必須變紅。
    const h = harness()
    const calls: string[] = []
    watchSubmission('S', 'submit', { onPending: () => calls.push('pending'), onSubmitted: () => calls.push('sent') }, h.deps)
    h.emit('ready')
    h.timers[0].fn()
    assert.deepEqual(calls, ['pending'])
    h.emit('awaiting-choice')
    assert.deepEqual(calls, ['pending', 'sent'])
  })
})

describe('unconfirmed submissions (session-hibernation)', () => {
  it('a filled-in prompt is unconfirmed until the agent starts working', async () => {
    const base = configure()
    const sessionId = 'H1'
    prepareEventInjection(sessionId, true)
    schedulePrefill(sessionId, 'x', { write: () => undefined, onTimeout: () => assert.fail('no timeout expected') })
    assert.equal(hasUnconfirmedSubmission(sessionId), false, 'nothing written before ready')

    fire(base, sessionId, { hook_event_name: 'SessionStart' })
    await waitFor('written once ready', () => hasUnconfirmedSubmission(sessionId))

    // The same watch the IPC layer starts once the text is written.
    watchSubmission(sessionId, 'fill', { onPending: () => undefined, onSubmitted: () => undefined })
    fire(base, sessionId, { hook_event_name: 'PreToolUse' })
    await waitFor('confirmed once the agent works', () => !hasUnconfirmedSubmission(sessionId))
    clearWait(sessionId)
  })

  it('the session ending forgets it', async () => {
    const base = configure()
    const sessionId = 'H2'
    prepareEventInjection(sessionId, true)
    fire(base, sessionId, { hook_event_name: 'SessionStart' })
    schedulePrefill(sessionId, 'x', { write: () => undefined, onTimeout: () => assert.fail('no timeout expected') })
    await waitFor('written', () => hasUnconfirmedSubmission(sessionId))
    forgetSubmission(sessionId)
    assert.equal(hasUnconfirmedSubmission(sessionId), false)
    clearWait(sessionId)
  })
})

describe('the prefill record (remote-prefill-send D4)', () => {
  const ITEM = { adapter: 'slack', id: 'i1' }
  /** The terminal service's write: every write is reported to `pty-input`, as `TerminalService.write` does. */
  const writer = (writes: string[] = []) => (sessionId: string, data: string) => {
    writes.push(data)
    noteWrite(sessionId, data)
  }
  async function filled(sessionId: string, opts: { mode?: 'fill' | 'submit'; startedAt?: number | null; before?: () => void } = {}) {
    const base = configure()
    prepareEventInjection(sessionId, true)
    forgetInput(sessionId)
    opts.before?.()
    const writes: string[] = []
    schedulePrefill(
      sessionId,
      'line one\nline two',
      { write: writer(writes), onTimeout: () => assert.fail('no timeout expected'), processStartedAt: () => opts.startedAt === undefined ? 0 : opts.startedAt },
      opts.mode ?? 'fill',
      ITEM,
    )
    fire(base, sessionId, { hook_event_name: 'SessionStart' })
    await waitFor('filled', () => prefillOf(sessionId) !== null)
    return { base, writes }
  }

  it('a fill records the exact text written and the item, offered and not edited', async () => {
    const { writes } = await filled('R1')
    const view = prefillOf('R1')
    assert.deepEqual({ ...view, id: typeof view?.id }, { id: 'string', text: 'line oneline two', intake: ITEM, edited: false, offered: true })
    assert.equal(writes[0], view?.text)
    forgetSubmission('R1')
    assert.equal(prefillOf('R1'), null)
    clearWait('R1')
  })

  it('each fill gets its own identity', async () => {
    await filled('R2')
    const first = prefillOf('R2')?.id
    forgetSubmission('R2')
    clearWait('R2')
    await filled('R2')
    assert.notEqual(prefillOf('R2')?.id, first)
    forgetSubmission('R2')
    clearWait('R2')
  })

  it('a keystroke after the fill marks it edited; the fill\'s own write and a noted key do not', async () => {
    await filled('R3')
    assert.equal(prefillOf('R3')?.edited, false, 'the fill\'s own write')
    noteWrite('R3', '\r')
    notePrefillKey('R3')
    assert.equal(prefillOf('R3')?.edited, false, 'a submit key the desktop noted')
    noteWrite('R3', 'x')
    assert.equal(prefillOf('R3')?.edited, true)
    forgetSubmission('R3')
    clearWait('R3')
  })

  it('a keystroke of this process before the fill marks it edited from the start; an earlier process\'s does not', async () => {
    // Control group: drop `typedBefore` from `edited` → the first assertion turns red; read it after the write →
    // the second turns red (the fill's own write counts).
    const now = Date.now()
    await filled('R4', { startedAt: now - 1000, before: () => noteWrite('R4', 'typed', undefined, now - 500) })
    assert.equal(prefillOf('R4')?.edited, true, 'typed after the process started')
    forgetSubmission('R4')
    clearWait('R4')
    await filled('R5', { startedAt: now, before: () => noteWrite('R5', 'typed', undefined, now - 500) })
    assert.equal(prefillOf('R5')?.edited, false, 'typed by a previous process')
    forgetSubmission('R5')
    clearWait('R5')
    await filled('R6', { startedAt: null, before: () => noteWrite('R6', 'typed', undefined, 1) })
    assert.equal(prefillOf('R6')?.edited, true, 'no spawn time: any keystroke counts')
    forgetSubmission('R6')
    clearWait('R6')
  })

  it('submit mode: not offered until the fallback, and its own submit key is not typing', async () => {
    // Control group: drop the `notePrefillKey` after the desktop's key → `edited` turns true (red).
    const { writes } = await filled('R7', { mode: 'submit' })
    assert.equal(prefillOf('R7')?.offered, false)
    await waitFor('the submit key', () => writes.includes(SUBMIT_KEY), SUBMIT_KEY_DELAY_MS + 2000)
    assert.equal(prefillOf('R7')?.edited, false)
    const timers: (() => void)[] = []
    watchSubmission('R7', 'submit', { onPending: () => undefined, onSubmitted: () => undefined }, {
      subscribe: () => () => undefined,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => undefined,
    })
    timers[0]()
    assert.equal(prefillOf('R7')?.offered, true, 'offered once the desktop falls back to "pending"')
    forgetSubmission('R7')
    clearWait('R7')
  })

  it('listeners hear a fill set, offered and removed; a start removes it', async () => {
    const heard: string[] = []
    const off = onPrefillChange((id) => heard.push(id))
    const { base } = await filled('R8', { mode: 'submit' })
    assert.deepEqual(heard.filter((id) => id === 'R8').length, 1, 'set')
    const timers: (() => void)[] = []
    watchSubmission('R8', 'submit', { onPending: () => undefined, onSubmitted: () => undefined }, {
      subscribe: () => () => undefined,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => undefined,
    })
    timers[0]()
    assert.equal(heard.filter((id) => id === 'R8').length, 2, 'offered')
    watchSubmission('R8', 'fill', { onPending: () => undefined, onSubmitted: () => undefined })
    fire(base, 'R8', { hook_event_name: 'PreToolUse' })
    await waitFor('removed on a start', () => prefillOf('R8') === null)
    assert.equal(heard.filter((id) => id === 'R8').length, 3, 'removed')
    off()
    clearWait('R8')
  })
})
