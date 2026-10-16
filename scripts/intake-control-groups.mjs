/**
 * 對照組 —— 把修正退回，確認那條斷言真的變紅。
 *
 * **這是唯一擋得住假綠的東西。** 這個 repo 每一條重要的守衛都這樣驗過，而幾次沒這樣驗的，
 * 全部是假綠。
 *
 * ## 腳本自己先證明 mutation 生效了
 *
 * 一個**沒有改到任何東西**的 mutation 與一個有效的 mutation，在輸出上長得一模一樣（都是綠的）。
 * 因此每一次替換之後先斷言檔案內容確實不同 —— 否則這支腳本自己就是一盞永遠亮綠的燈。
 *
 * ## 還原之後要重建
 *
 * 探針跑的是 `out/` 的產物。`PROBE_SKIP_BUILD=1` 之下還原原始碼**不等於**還原產物 ——
 * 這支腳本不跳過建置，於是每一輪都是被出貨的那份程式碼。
 *
 * ## 載體有兩種，而指名錯的代價是一個紅不起來的對照組
 *
 * `command: 'test'` 的 mutation 走 `npm test`，其餘走 `npm run probe:intake`。
 * **只跑 probe 的執行器會把每一個單元測試級的 mutation 判成「沒有變紅」** —— 於是那些對照組
 * 看起來有人管，實際上從來沒有證明過任何事。
 *
 * 用法：`node scripts/intake-control-groups.mjs [名稱…]`
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 每一條都指名**哪一條斷言必須變紅**。
 *
 * 沒有指名的話，一個「因為別的理由紅了」的 mutation 會被當成通過 —— 而那正是這支腳本要防的。
 */
export const MUTATIONS = [
  // ── agent-session-control ──
  {
    name: 'control-self-close-not-offered',
    section: 'runSessionControl',
    file: 'src/main/session-control.ts',
    from: `      if (command.kind === 'close' && self && running) {`,
    to: `      if (false) {`,
    expectRed: "an agent's close of its own session is offered when its turn ends, and the session keeps running",
    why: '**Close the agent\'s own session at its turn end instead of offering it** (design D12): its last reply vanishes.',
  },
  {
    name: 'control-offer-blocks-content',
    section: 'runSessionControl',
    file: 'src/renderer/src/shell/terminal/TerminalView.tsx',
    from: `        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center pt-3">`,
    to: `        <div className="absolute inset-0 z-10 flex justify-center bg-shell/60 pt-3">`,
    expectRed: 'the offer leaves the terminal under it reachable, and takes no focus',
    why: '**A covering backdrop**: the terminal under the offer can no longer be scrolled or selected.',
  },
  {
    name: 'control-acts-at-once',
    section: 'runSessionControl',
    file: 'src/main/session-control.ts',
    from: `    if (!this.#deps.inTurn(target.id)) {`,
    to: `    if (true) {`,
    expectRed: 'a close on a child in its turn waits: the child still runs, its record remains',
    why: '**Carry a close out at once, whatever the target is doing** — the turn rule (design D3) removed.',
  },
  {
    name: 'control-waits-on-ready',
    section: 'runSessionControl',
    file: 'src/main/agent-wait.ts',
    from: `  if (held.submitted) return true`,
    to: `  return stateOf(held) !== 'ready'`,
    expectRed: 'a Stop with a background subagent running does not end the turn',
    why: '**"In a turn" read from the wait state** (`ready` = rest): a `Stop` with a background subagent reads ready.',
  },
  {
    name: 'control-keystroke-not-a-turn',
    command: 'test',
    file: 'src/main/agent-wait.ts',
    from: `  if (keystrokeAt === null) return false`,
    to: `  return false`,
    expectRed: 'a keystroke after the last turn end with no event (a `!cmd`) is a turn until the next Stop',
    why: '**Only events start a turn** — a `!cmd` reports nothing until its `Stop` (measured), so it would read at rest.',
  },
  {
    name: 'control-keystroke-ignored',
    section: 'runSessionControl',
    file: 'src/main/session-control.ts',
    from: `      this.#drop(sessionId)
      this.#withdrawOffer(sessionId)`,
    to: `      this.#withdrawOffer(sessionId)`,
    expectRed: 'a keystroke into the target drops its waiting close: it survives its turn end',
    why: '**A keystroke does not drop a waiting command** — the user took the session back and it closes anyway.',
  },
  {
    name: 'control-parent-only',
    section: 'runSessionControl',
    file: 'src/main/session-control.ts',
    from: `      ancestryOf(session.id, (id) => records.get(id)).includes(sourceId)`,
    to: `      session.lineage?.parentId === sourceId`,
    expectRed: 'a grandchild at rest is hibernated at once through a closed intermediate: no process, record kept',
    why: '**Authorize by the direct parent only** — a grandchild becomes unreachable.',
  },
  {
    name: 'control-no-ancestry-at-ingestion',
    section: 'runSessionControl',
    file: 'src/main/handoff-ticket.ts',
    from: `      ...(source.ancestors?.length ? { ancestors: [...source.ancestors] } : {}),`,
    to: ``,
    expectRed: "G's lineage records the chain above its parent, taken at ingestion",
    why: '**Do not copy the chain taken at ingestion** — a grandchild loses its grandparent once its parent closes.',
  },
  {
    name: 'control-no-staleness',
    command: 'test',
    file: 'src/main/session-control.ts',
    from: `    return mtimeMs < since`,
    to: `    return false`,
    expectRed: "a close written before the target's last start or end, or before this run, is dropped",
    why: "**A command never yields to what happened afterwards** (design D11): a self-close left unread at quit closes the session after a restart.",
  },

  {
    name: 'count-only-when-open',
    file: 'src/renderer/src/shell/intake/intake-state.tsx',
    from: `    const unsubscribe = window.workspace.intake.onChanged(refresh)
    refresh()
    return unsubscribe`,
    to: `    const unsubscribe = window.workspace.intake.onChanged(refresh)
    return unsubscribe`,
    expectRed: '從未打開過收件匣時仍呈現計數',
    why: '**退回現況：只在收件匣被打開時才拉一次清單。**\n'
      + '> 主行程的收件者集合是在 renderer 第一次呼叫 `list()` 時才註冊的，於是一個從來沒有被\n'
      + '> 打開過的收件匣，其變化不會推給任何人。\n'
      + '> **不要用「把 `list()` 整個拿掉」當 mutation** —— 那會讓這一段的每一條都變紅，\n'
      + '> 證明的只是「provider 有在拉資料」，不是那個既有缺陷。',
  },
  {
    name: 'focus-follows-rerender',
    file: 'src/renderer/src/shell/intake/IntakeOverlay.tsx',
    from: `  useEffect(() => {
    closeRef.current?.focus()
  }, [])`,
    to: `  useEffect(() => {
    closeRef.current?.focus()
  }, [snapshot])`,
    expectRed: '收件匣變動不把焦點搶回關閉鈕',
    why: '**把一次性的初始聚焦綁到一個會變的值上。**\n'
      + '> 「掛載」不是「改變」—— 收件匣每更新一次，焦點就被搶回關閉鈕，而使用者可能正在\n'
      + '> 編輯 routing 規則。\n'
      + '> **第一版的 mutation 是把依賴改回 `close`，而它紅不起來** —— 因為修法有兩處（overlay 的\n'
      + '> 依賴陣列、以及父層把回呼改成穩定的 identity），任一處單獨還原都不足以重現。\n'
      + '> 對照組於是抓到一個不是假綠、但也證明不了東西的 mutation：**一個跨兩個檔案的缺陷，\n'
      + '> 單點替換表達不出來**。改成這個等價而單點的形狀。',
  },
  {
    name: 'badge-label-merged',
    file: 'src/renderer/src/shell/ActivityBar.tsx',
    from: `              aria-label={label}`,
    to: `              aria-label={item.id === 'handoffs' && pendingCount > 0 ? label + ' (' + pendingCount + ')' : label}`,
    expectRed: '從未打開過收件匣時仍呈現計數',
    why: '**把計數併進入口的無障礙標籤。** 在本 repo 中那個標籤同時是驗收定位元素的手段 ——\n'
      + '> 徵狀不是斷言失敗，是**選不到元素**（求值得空值）。這個 mutation 會讓整段的定位\n'
      + '> 一起失效，而那正是它要示範的代價。',
  },
  {
    name: 'merge-debounce',
    command: 'test',
    file: 'src/main/intake-notify.ts',
    from: `    if (this.#cancel !== null) return
    this.#cancel = this.#clock.after(this.#windowMs, () => this.#flush())`,
    to: `    if (this.#cancel !== null) this.#cancel()
    this.#cancel = this.#clock.after(this.#windowMs, () => this.#flush())`,
    expectRed: '**持續到達時通知不被無限延後**',
    why: '**固定窗口換成 debounce**（每次到達都把計時器往後推）。\n'
      + '> 兩種實作在「單則到達」與「一次批次」下的結果**完全相同** —— 只有持續到達時才分岔，\n'
      + '> 而那時 debounce 的計時器永遠不會到期。這個對照組是那條 requirement 唯一的鑑別力來源。',
  },
  {
    name: 'burst-unbounded',
    command: 'test',
    file: 'src/main/intake-notify.ts',
    from: `    if (this.#presented.length >= this.#burstMax) return`,
    to: `    if (false && this.#presented.length >= this.#burstMax) return`,
    expectRed: '**逾越上界之後不再各自發出，打開收件匣即重置**',
    why: '**拿掉窗與窗之間的上界。** 合併只防批次、不防節奏 —— 每個窗恰好一則時合併完全不介入。',
  },
  {
    name: 'title-carries-authored',
    command: 'test',
    file: 'src/main/intake-notify.ts',
    // **錨點帶下一行** —— `title: t('intake.notify.title')` 自本 change 起在這個檔案裡
    // 出現兩次（到達的那一則與失敗的那一則），單獨用它會命中兩處而讓對照組失效。
    from: `    title: t('intake.notify.title'),\n    body: actor`,
    to: `    title: \`${'${'}t('intake.notify.title')} — ${'${'}title}\`,\n    body: actor`,
    expectRed: '**標題不含投遞提供的任何值**',
    why: '**讓投遞者的標題進到通知的標題。** 桌面上於是出現一則與本應用程式自己發出的別無二致'
      + '的訊息，而使用者沒有任何線索分辨。',
  },
  {
    name: 'reduce-truncate-only',
    command: 'test',
    file: 'src/main/intake-notify.ts',
    from: `  const withoutUrls = value.replace(URL_SHAPE, t('intake.notify.link'))
  const withoutMarkup = withoutUrls.replace(/[<>&]/g, '')`,
    to: `  const withoutMarkup = value`,
    expectRed: '**會被詮釋為標記的字元被移除**',
    why: '**縮減只做截短。** 第三方於是取得桌面上的排版控制權，而 URL 會被通知服務變成可點的'
      + '連結（點在那一塊上還不會觸發「打開收件匣」）。',
  },
  {
    name: 'arrival-from-state',
    command: 'test',
    file: 'src/main/intake-service.ts',
    from: `    this.#maxPending = maxPending`,
    to: `    this.#maxPending = maxPending
    queueMicrotask(() => {
      for (const record of store.list()) if (record.state === 'pending') this.#emitArrival(record)
    })`,
    expectRed: '**以已有待處理項目的狀態檔建構，不發出任何到達**',
    why: '**把觸發從「到達」改寫成「存在待處理項目」。** 那個改寫在程式碼上更短、看起來像簡化，'
      + '而它會讓每一次開機把收件匣裡積著的東西重新通知一遍。',
  },
  {
    name: 'arrival-on-notice',
    command: 'test',
    file: 'src/main/intake-service.ts',
    from: `  #emit(): void {
    for (const listener of this.#listeners) listener()
  }`,
    to: `  #emit(): void {
    for (const listener of this.#listeners) listener()
    for (const listener of this.#arrivals) listener(undefined as never)
  }`,
    expectRed: '**識別碼不合法（INVALID_ID）不發出到達**',
    why: '**把到達接到「有東西變了」那個既有通道上。**\n'
      + '> 這同時就是「接到 `DeliverOutcome.notify`」那個 mutation —— 兩者在程式碼上是同一件事：\n'
      + '> `#emit()` 恰好只在四條拒絕路徑上被呼叫，而那四條**正是** `notify: true` 的那四條\n'
      + '> （`MALFORMED` 與內容相同的重複兩條直接 return，不經 `#emit()`）。\n'
      + '> 所以這個 mutation 讓四條變紅，不是六條 —— 而那四條就是使用者會看到桌面跳通知的那些。',
  },
  {
    name: 'prefill-no-wait',
    file: 'src/main/intake-prefill.ts',
    from: `  const timer = setTimeout(() => finish(false), PREFILL_TIMEOUT_MS)`,
    to: `  fill()\n  const timer = setTimeout(() => finish(false), PREFILL_TIMEOUT_MS)`,
    expectRed: '就緒之前的整段期間未向該 session 寫入任何內容',
    why: '**pty 建立完成之後、不等待就緒即寫入。** 不可用「建立後立即寫入」當 mutation —— '
      + '那時 pty 可能還不存在、寫入會被丟棄，mutant 什麼都沒做而對照組保持綠。\n'
      + '> **這條曾經「紅不起來」，而那是替身壞掉的產物，不是這條斷言的性質。** 替身當時把'
      + '讀取迴圈放在背景並在一次空讀後就退出，於是提早寫入的位元組沒有人讀 —— 收據照樣是空的。'
      + '把讀取迴圈搬回前景（阻塞，它本來就是替身活著的理由）之後，這條就抓得到了。'
      + '**差點據此把一條有效的斷言降級成「留著當回歸」。**',
  },
  {
    name: 'transform-at-presentation',
    file: 'src/renderer/src/shell/intake/IntakeOverlay.tsx',
    from: `      <p className="mt-2 whitespace-pre-wrap break-words text-2xs text-ink-muted">{item.body}</p>`,
    to: `      <p className="mt-2 whitespace-pre-wrap break-words text-2xs text-ink-muted">`
      + `{item.body.replace(/\\s+/g, ' ')}</p>`,
    expectRed: '交給 agent 的內容逐字元等於呈現給使用者的本文',
    why: '**呈現層多做了一次交付層沒做的轉換**（收斂空白）—— 於是使用者看到的與 agent 讀到的'
      + '差在一組看不見的字元上。\n'
      + '第一版的 mutation 是「把攝入的正規化整個拿掉」，而那**不會變紅** —— 兩端都用原字串，'
      + '它們仍然相同。要模擬的是分岔，不是「都不做」。',
  },
  {
    name: 'system-names-session',
    // The desktop's accept lives in `accept-flow.ts` since `mobile-remote-bridge` (shared with a paired device).
    file: 'src/renderer/src/shell/intake/accept-flow.ts',
    from: `  await deps.intake.attach(item.id, item.adapter, sessionId)`,
    to: `  ;(deps.sessions as unknown as { rename: (id: string, title: string) => void }).rename(sessionId, 'SYSTEM-NAMED')\n`
      + `  await deps.intake.attach(item.id, item.adapter, sessionId)`,
    expectRed: 'session 的名稱未被系統指定（agent 宣告的標題呈現得出來）',
    why: '系統代為命名＝使用者永久接管命名權，此後 agent 宣告的標題被靜默地不予呈現。',
  },
  {
    name: 'routing-uses-fallback',
    file: 'src/main/intake-routing.ts',
    from: `  for (const rule of config.rules) {`,
    to: `  for (const rule of [] as RoutingRule[]) {`,
    expectRed: '接受之前看得到將開在哪個 folder（第二個，不是選中的或第一個）',
    why: '規則不生效即落到 fallback（第一個 folder）。fixture 的形狀'
      + '（三個 folder、選第三、規則指第二、fallback 指第一）正是為了讓這種錯誤實作紅。',
  },
  {
    name: 'handoff-hooks-overwrite',
    file: 'src/main/agent-injection.ts',
    from: `      const entry = (hooks[event] ??= [{ matcher: '', hooks: [] }])`,
    to: `      const entry = (hooks[event] = [{ matcher: '', hooks: [] }])`,
    expectRed: 'SessionStart 上兩條注入的命令都被執行',
    why: '**hooks 的合成改回逐鍵覆蓋。** 事件橋接與自我介紹都貢獻 `SessionStart`，覆蓋之下只剩\n'
      + '> 最後註冊的那一個 —— 而兩個功能仍然都會回報自己已啟用。\n'
      + '> **註冊順序是這個對照組鑑別力的前提**（`terminal.ts` 有註解釘住它）。',
  },
  {
    name: 'handoff-target-prefix',
    file: 'src/main/handoff-target.ts',
    from: `  const byName = candidates.filter((candidate) => candidate.name.toLowerCase() === wanted.toLowerCase())`,
    to: `  const byName = candidates.filter((candidate) => candidate.name.toLowerCase().startsWith(wanted.toLowerCase()))`,
    expectRed: '前綴不算命中（模糊比對的實作會在這裡開出一個 session）',
    why: '**完整相等換成前綴比對。** 這條路徑上沒有使用者在看 —— 一個「猜得很有把握」的結果會讓\n'
      + '> session 開在他沒有指名的 repo 裡，而他不會知道。',
  },
  {
    name: 'handoff-payload-target',
    command: 'test',
    file: 'src/main/intake-schema.ts',
    from: `        ...(provenance ? { targetFolderId: provenance.targetFolderId } : {}),`,
    to: `        ...(typeof (source as { targetFolderId?: unknown }).targetFolderId === 'string'
          ? { targetFolderId: String((source as { targetFolderId: string }).targetFolderId) }
          : provenance
            ? { targetFolderId: provenance.targetFolderId }
            : {}),`,
    expectRed: '投遞內容自稱的目標不被採信 —— 目標只由查表決定',
    why: '**讓 payload 的 `targetFolderId` 被採信。** 共用投遞落點明文是給應用程式之外的 producer\n'
      + '> 用的 —— 這個欄位一旦讀得到，**任何**放進落點的檔案都能繞過 routing 自選 folder。',
  },
  {
    name: 'handoff-stays-pending',
    file: 'src/main/handoff-service.ts',
    section: 'runHandoff',
    // 上限已於 handoff-session-lifecycle 移除 —— 此前這個 mutation 下手在上限的判斷上，
    // 現在直接拿掉到達即接受本身（那是這條斷言唯一要驗的事）。
    from: `    this.#deps.requestAutoAccept(HANDOFF_ADAPTER, outcome.record.id, target.folderId)`,
    to: `    void this.#deps.requestAutoAccept`,
    expectRed: '交接於到達時直接建立 session（使用者未執行任何接受動作）',
    why: '**拿掉自動接受。** 交接退回成一則普通的待處理項目 —— 使用者剛親口交辦的事，他得再同意一次。',
  },
  {
    name: 'handoff-steals-focus',
    file: 'src/renderer/src/shell/intake/IntakeAutoAccept.tsx',
    from: `          if (outcome.status !== 'created') return`,
    to: `          if (outcome.status !== 'created') return
          latest.current.onReveal(folderId)`,
    expectRed: 'rail 上選中的項目未因交接而改變',
    why: '**建立之後把焦點切過去。** 這條 requirement **零實作即綠**（不寫任何焦點程式碼，焦點自然\n'
      + '> 不動），它的鑑別力**完全**來自這個對照組。',
  },
  // ── handoff-body-limit-and-rejection-visibility ─────────────────────────
  {
    name: 'handoff-failures-not-notified',
    file: 'src/main/handoff-service.ts',
    section: 'runHandoffFailure',
    from: `      notifyFailures: true,`,
    to: `      notifyFailures: false,`,
    expectRed: '目標查無時發出通知（這條路徑上沒有人在等著按接受）',
    why: '**失敗只寫進收件匣，不發通知。** 接受那個環節已經沒有人在看 —— 使用者不會無緣無故\n'
      + '> 去打開收件匣，於是一次失敗的交接與「什麼都沒發生」在畫面上完全相同。\n'
      + '> 這正是本 change 的起點：那條斷言曾經是綠的，而通知從未被發出過。',
  },
  {
    name: 'too-long-treated-as-transient',
    file: 'src/main/intake-rejection.ts',
    section: 'runHandoffFailure',
    from: `export function isPermanentRejection({ code, notify }: RejectionOutcome): boolean {\n  switch (code) {`,
    to: `export function isPermanentRejection({ code, notify }: RejectionOutcome): boolean {\n  if (code === 'TOO_LONG') return false\n  switch (code) {`,
    expectRed: 'TOO_LONG：共用攝入路徑上的永久性失敗同樣發出通知',
    why: '**把「本文過長」判成暫時性。** 它於是不通知、不落盤 —— 而重送同一份投遞必然同樣失敗，\n'
      + '> 使用者永遠等不到那個「狀態改變之後就會成功」的時刻。',
  },
  {
    name: 'oversize-not-reported',
    file: 'src/main/intake-source.ts',
    section: 'runHandoffFailure',
    from: `      this.#reportIfPermanent(\n        this.#service.rejectOversize(path.basename(file), { adapter: this.#adapter }),\n      )`,
    to: `      this.#service.rejectOversize(path.basename(file), { adapter: this.#adapter })`,
    expectRed: 'TOO_LARGE：共用攝入路徑上的永久性失敗同樣發出通知',
    why: '**把通知接回 adapter 的 `deliver`。** 超過檔案大小上限的投遞在 `readBounded` 就被擋下\n'
      + '> 並消費掉，它**永遠不會走到** `deliver` —— 於是 `TOO_LARGE` 結構上通知不出來，\n'
      + '> 而那個缺口不會有任何東西變紅。',
  },
  {
    name: 'notices-not-persisted',
    file: 'src/main/intake-service.ts',
    section: 'runHandoffFailure',
    from: `  #persistNotices(): void {\n    this.#store.setNotices(this.#notices)\n  }`,
    to: `  #persistNotices(): void {\n    void this.#store\n  }`,
    expectRed: '失敗的呈現活過重新啟動',
    why: '**痕跡只活在行程記憶體裡。** 一則失敗的可見性於是取決於使用者在關掉應用程式之前剛好\n'
      + '> 打開過收件匣 —— 而促使他去打開收件匣的那個訊號（通知）正是同一條路徑上的東西。\n'
      + '> 兩者同時只在一次執行之內有效時，「可見」在實際使用中等於「不可見」。',
  },
  // ── handoff-outbox-watch-survives-restore ───────────────────────────────
  {
    name: 'outbox-recreated-on-prepare',
    file: 'src/main/handoff-outbox.ts',
    command: 'test',
    from: `    // \`lstat\` 而非 \`stat\`：指向別處的 symlink 也要當成「不是我們的落點」而重建。
    const existing = fs.lstatSync(dir, { throwIfNoEntry: false })
    if (!existing?.isDirectory()) {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.mkdirSync(dir, { recursive: true })
    }`,
    to: `    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })`,
    expectRed: '落點被重新準備之後，其後寫入的投遞仍被偵測',
    why: '**退回「準備落點＝刪掉再重建」。** 落點的監看綁定的是目錄這個**對象**，刪掉再建立之後\n'
      + '> 它留在一個不再有動靜的舊對象上 —— 該 session 的投遞從此石沉大海，而來源 agent 回報\n'
      + '> 它已經交接出去了。**這個 mutation 同時讓另外兩條變紅**（「未被消費的投遞不被清掉」\n'
      + '> 與 fd 判準），那是刻意的：後者沒有專屬的 mutation（同步函式裡讓不出 event loop\n'
      + '> tick，「rm → 讓出一個 tick → mkdir」那個變體寫不出來），它獨立的價值在於**與時序\n'
      + '> 無關**。\n'
      + '> **若某天這條不再變紅**，那是 chokidar 換了行為的警報，不是把對照組刪掉的理由 ——\n'
      + '> 屆時要重新論證「不碰那個目錄」這個不變式還承不承重。',
  },
  {
    name: 'outbox-recreated-on-prepare-probe',
    file: 'src/main/handoff-outbox.ts',
    section: 'runHandoffRestored',
    from: `    // \`lstat\` 而非 \`stat\`：指向別處的 symlink 也要當成「不是我們的落點」而重建。
    const existing = fs.lstatSync(dir, { throwIfNoEntry: false })
    if (!existing?.isDirectory()) {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.mkdirSync(dir, { recursive: true })
    }`,
    to: `    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })`,
    expectRed: '落點被重新準備之後（session 被還原），其後寫入的交接仍被偵測並建立 session',
    why: '**同一個 mutation，另一個載體。** 單元測試證明得了「監看路徑在重新準備之後還通」，\n'
      + '> 證明不了被出貨的那份程式碼在真實的**還原**路徑上也是如此（`sessions.json` 被還原、\n'
      + '> 休眠的 session 被喚醒、落點在那一刻被重新準備）。\n'
      + '> **只登記其中一條的代價是另一個載體從來沒有被證明有鑑別力。**\n'
      + '> 這一段的兩條**前置**在這個 mutation 之下仍然是綠的，而那是它們存在的理由：\n'
      + '> 它們證明監看確實掛上了、session 確實被喚醒了，於是唯一紅的那條就是規格說的那件事。',
  },
  {
    name: 'handoff-notify-always-inbox',
    file: 'src/main/index.ts',
    from: `    if (sessionId) focusSession?.(sessionId)`,
    to: `    if (false && sessionId) focusSession?.(sessionId)`,
    expectRed: '觸發交接的通知不打開收件匣',
    why: '**通知的效果不再分流。** 一則已接受的交接在收件匣裡沒有任何待辦動作 —— 把使用者送去那裡，\n'
      + '> 等於要他再點一次才到得了他真正要去的地方。',
  },
  // ── intake-inbox-usability ────────────────────────────────────────────────
  {
    name: 'accept-falls-back-to-routing',
    file: 'src/main/ipc/intake.ts',
    section: 'runChooseFolder',
    from: `        chosenFolderId: folderId,`,
    to: `        chosenFolderId: folderId ?? routing.get().fallbackFolderId ?? routing.get().rules[0]?.folderId,`,
    expectRed: '未指明確認的 folder 的接受被拒絕，即使解析得出',
    why: '**缺了使用者確認的 folder 時，handler 退回 routing。** 判定函式的輸入不含解析結果，\n'
      + '> 退回只可能寫在 handler 這一層 —— 而經畫面的斷言對它一律是綠的（畫面永遠送出呈現值、\n'
      + '> 停用的按鈕點不到主行程）。唯一的載體是探針直接呼叫 IPC 的那一條。',
  },
  {
    name: 'override-in-card',
    file: 'src/renderer/src/shell/intake/IntakeOverlay.tsx',
    section: 'runChooseFolder',
    from: `            onClick={() => setTab('rules')}`,
    to: `            onClick={() => { setTab('rules'); setOverrides(new Map()) }}`,
    expectRed: '改選之後規則的變動不覆蓋使用者的選擇',
    why: '**改選在切到 Rules 分頁時消失** —— 那正是把它放在卡片裡的後果（卡片在那一刻卸載）。\n'
      + '> 把狀態搬回卡片是跨好幾處的改動，單點替換表達不出來；這是它**等價而單點**的形狀。\n'
      + '> 直接呼叫 setRules 的斷言對它是綠的 —— 使用者改規則一定要先切到那個分頁。',
  },
  {
    name: 'preselect-ignores-session',
    command: 'test',
    file: 'src/renderer/src/shell/intake/preselect-folder.ts',
    from: `  if (known(existingSessionFolderId)) return { folderId: existingSessionFolderId, overrideGone: false }\n`,
    to: ``,
    expectRed: '預填逾時退回者預選既有 session 所在的 folder',
    why: '**預選不看既有 session。** 第一次接受時改選過 folder、預填逾時退回待處理之後，\n'
      + '> 重新打開收件匣預選回解析結果 —— 使用者沒注意就按下接受，本文送進他先前改掉的 repo。',
  },
  {
    name: 'reuse-ignores-folder',
    command: 'test',
    file: 'src/renderer/src/shell/intake/reuse-session.ts',
    from: `  return session && session.folderId === chosenFolderId ? existingSessionId : null`,
    to: `  return session ? existingSessionId : null`,
    expectRed: '逾時之後改選別的 folder 再次處理 ⇒ 不沿用原 folder 的那一個',
    why: '**沿用舊 session 時不問它在哪個 folder。** 使用者改選之後，prompt 被填進原 folder 的那一個。',
  },
  {
    name: 'unknown-counts-as-sent',
    command: 'test',
    file: 'src/main/intake-prefill.ts',
    from: `  return state === 'busy' || state === 'awaiting-choice'`,
    to: `  return state !== 'ready'`,
    expectRed: '等待狀態落回未知不視為已送出',
    why: '**退回舊判定：「不再是 ready」就算送出。** 落回未知的事件會被當成送出 ——\n'
      + '> 而判定的後果會落盤，把交接的本文從它唯一的呈現位置永久移除。',
  },
  {
    name: 'accept-keeps-settled',
    command: 'test',
    file: 'src/main/intake-store.ts',
    from: `    if (state === 'accepted') delete record.settledAt\n`,
    to: ``,
    expectRed: '再次被接受時了結的標記被清除',
    why: '**再次接受時不清除了結的標記。** 預填前清除 → 逾時退回 → 再次接受，它一建立 session\n'
      + '> 就從收件匣消失，使用者看不到他正要送出的本文。',
  },
  {
    name: 'settled-dropped-on-load',
    command: 'test',
    file: 'src/main/intake-store.ts',
    from: `      ...(typeof e.settledAt === 'number' ? { settledAt: e.settledAt } : {}),\n`,
    to: ``,
    expectRed: '已了結的項目狀態仍為已接受',
    why: '**逐欄位白名單漏掉 settledAt。** 了結的標記活不過重啟 —— 使用者清掉的東西每次開機都回來。',
  },
  {
    name: 'settled-still-listed',
    command: 'test',
    file: 'src/main/intake-projection.ts',
    from: `    .filter((record) => !(record.state === 'accepted' && record.settledAt !== undefined))\n`,
    to: ``,
    expectRed: '已了結者不在清單中，未了結的已接受者仍在',
    why: '**清單不看了結。** 已開好那一段回到「只進不出」—— 本 change 的起點。',
  },
  {
    name: 'opened-folder-from-routing',
    command: 'test',
    file: 'src/main/intake-projection.ts',
    from: `  if (record.state !== 'pending') return withBody\n`,
    to: ``,
    expectRed: '已接受者沒有 folderId —— 規則改指別處也一樣',
    why: '**已接受者也在列出時重算 routing。** 那報的是「現在的規則會解到哪」，不是它開在哪 ——\n'
      + '> 接受時使用者改選過、或規則事後改變，「Opened in」就標錯。',
  },
  {
    name: 'sort-by-insertion',
    command: 'test',
    file: 'src/main/intake-projection.ts',
    from: `    .sort(byNewestOccurrence)`,
    to: `    .reverse()`,
    expectRed: '以打亂的落盤順序種入，輸出為到達時間由新到舊',
    why: '**以反轉插入順序代替排序。** 種入順序若恰好是由舊到新，這個錯誤實作會通過 ——\n'
      + '> 那正是 fixture 刻意打亂的理由。',
  },
  {
    name: 'no-startup-settle',
    file: 'src/main/index.ts',
    section: 'runOpenedLifecycle',
    from: `  intakeStore.settleOpened()\n`,
    to: ``,
    expectRed: '上一次執行接受而未送出的項目，啟動後不再呈現（session 仍被還原、狀態仍為已接受、了結落盤）',
    why: '**啟動時不了結。** 上一次執行接受而沒送出的項目（session 被還原、預填的 prompt 已隨 pty\n'
      + '> 消失）只剩手動清除一條出口，一次次累積 —— dogfood 回報的「Opened in 還是沒消失」。',
  },
  {
    name: 'time-shows-received',
    file: 'src/renderer/src/shell/intake/IntakeOverlay.tsx',
    section: 'runOpenedLifecycle',
    from: `        <span className="text-2xs text-ink-faint">{item.originLabel}</span>
        <OccurredAt at={item.occurredAt} />`,
    to: `        <span className="text-2xs text-ink-faint">{item.originLabel}</span>
        <OccurredAt at={item.receivedAt} />`,
    expectRed: '每一則呈現發生時間的完整日期與時刻（宣告者為發生時間、未宣告者為到達時間）',
    why: '**呈現到達時間而非發生時間** —— dogfood 踩到的那個形狀：回補進來的昨天的提及顯示成今天。\n'
      + '> 種入的項目發生時間與到達時間相差數小時；只驗「有一個時間」的斷言對它是綠的。',
  },
  {
    name: 'sort-by-received',
    command: 'test',
    file: 'src/main/intake-projection.ts',
    from: `  return b.occurredAt - a.occurredAt`,
    to: `  return b.receivedAt - a.receivedAt`,
    expectRed: '回補的形狀：到達時間相同、發生時間各異 ⇒ 依發生時間由新到舊',
    why: '**依到達時間排序。** 回補一次進來的項目到達時間幾乎相同，依它排序等於沒有排序。',
  },
  {
    name: 'future-not-clamped',
    command: 'test',
    file: 'src/main/intake-projection.ts',
    from: `Math.min(declared, receivedAt)`,
    to: `declared`,
    expectRed: '宣告未來時刻者的有效時間為到達時間 —— 釘不上最上面',
    why: '**不夾住宣告的發生時間。** 那個欄位是投遞者撰寫的 —— 宣告一個未來的時刻就能把自己釘在\n'
      + '> 收件匣的最上面。',
  },
  {
    name: 'settle-not-on-submit',
    file: 'src/main/ipc/intake.ts',
    // 使用者自己按 Enter 的那一條住在退路的變體裡（handoff-session-lifecycle 起交接被代為送出）。
    section: 'runHandoffUnsent',
    from: `              service.store.settle(adapter, id)`,
    to: ``,
    expectRed: '送出之後不再呈現，且了結落盤',
    why: '**送出之後只撤標示、不落盤了結。** 畫面上它照樣離開不了已開好那一段 ——\n'
      + '> 而只看「載入時帶 settledAt 就不呈現」的斷言對它是綠的。',
  },
  // ── handoff-session-lifecycle ───────────────────────────────────────────────
  {
    name: 'handoff-not-submitted',
    file: 'src/main/intake-prefill.ts',
    section: 'runHandoff',
    from: `  return input.firstPartyBody && !input.reusedSession ? 'submit' : 'fill'`,
    to: `  return 'fill'`,
    expectRed: '交接建立的 session 其第一則 prompt 被代為送出（恰好一個 session 收到恰好一行）',
    why: '**交接改回填好而不送出。** 使用者得回到 spekterm 按下送出 —— 這個 change 要拿掉的正是那一趟。',
  },
  {
    name: 'fallback-resubmits',
    file: 'src/main/ipc/intake.ts',
    section: 'runHandoffUnsent',
    from: `            onPending: () => {`,
    to: `            onPending: () => {
              existingTerminalService(sender.id)?.write(sessionId, '\\r')`,
    expectRed: '退路不補送：送出字元只寫過一次，且沒有任何一行進入 agent 的紀錄',
    why: '**退路補送一次送出字元。** 那段時間使用者可能已經在那個 session 裡打字 —— 補送會把他打到\n'
      + '> 一半的內容一起送出。',
  },
  {
    name: 'submit-joined',
    file: 'src/main/intake-prefill.ts',
    command: 'test',
    from: `    if (mode === 'submit') setTimeout(() => deps.write(sessionId, SUBMIT_KEY), SUBMIT_KEY_DELAY_MS)`,
    to: `    if (mode === 'submit') deps.write(sessionId, SUBMIT_KEY)`,
    expectRed: 'schedulePrefill 以送出模式寫入時，就緒後寫下的內容以送出字元結尾',
    why: '**送出字元緊跟著文字寫。** 長文字一次抵達被 agent 當成貼上，緊跟在後的 `\\r` 被併進貼上成為換行 ——\n'
      + '> 文字停在輸入框、沒有送出（dogfood 實際踩到，CLI 2.1.283）。',
  },
  {
    name: 'completion-note-unreduced',
    file: 'src/main/intake-notify.ts',
    command: 'test',
    from: `    const summary = reduceForNotification(completions[0].summary)`,
    to: `    const summary = completions[0].summary`,
    expectRed: '摘要中的網址不進入通知',
    why: '**摘要不經縮減就進通知。** 桌面服務會把其中的網址變成可點的連結 —— 而摘要是 agent 寫的。',
  },
  {
    name: 'completion-reveal-as-intake',
    file: 'src/main/index.ts',
    section: 'runCompletion',
    from: `    if (keys.length === 1 && keys[0].adapter === COMPLETION_ADAPTER) {`,
    to: `    if (false) {`,
    expectRed: '觸發完成通知：選中子 session 所屬的 folder，並打開它的交接單呈現結果',
    why: '**完成通知走收件匣的分流。** 它不是 intake，查不到任何紀錄 ⇒ 打開收件匣 —— 結果不在那裡。',
  },
  {
    name: 'reuse-also-submits',
    file: 'src/main/intake-prefill.ts',
    command: 'test',
    from: `  return input.firstPartyBody && !input.reusedSession ? 'submit' : 'fill'`,
    to: `  return input.firstPartyBody ? 'submit' : 'fill'`,
    expectRed: '非第三方本文、新建的 session ⇒ 送出；其餘一律只填入',
    why: '**沿用既有 session 時也代為送出。** 逾時退回之後使用者可能已經在那個 session 裡打了字 ——\n'
      + '> `prompt\\r` 會接在他打到一半的內容後面一起送出。',
  },
  {
    name: 'label-pty-first',
    file: 'src/shared/lineage/label.ts',
    command: 'test',
    from: `  return session.customTitle ?? (handoffTitle && handoffTitle.trim() !== '' ? handoffTitle : undefined) ?? session.title`,
    to: `  return session.customTitle ?? session.title ?? (handoffTitle && handoffTitle.trim() !== '' ? handoffTitle : undefined)`,
    expectRed: '交接的標題是預設：高於 pty 宣告的標題',
    why: '**pty 標題排在交接標題之前。** 交接出來的 session 以固定名字啟動，pty 標題恆為那個名字 ——\n'
      + '> 交接的標題從此不會被看見。',
  },
  {
    name: 'report-truncated',
    file: 'src/main/handoff-delivery.ts',
    command: 'test',
    from: `  if (summary.length > MAX_REPORT_LENGTH) return { ok: false, reason: 'TOO_LONG', length: summary.length }`,
    to: `  if (summary.length > MAX_REPORT_LENGTH) return { ok: true, summary: summary.slice(0, MAX_REPORT_LENGTH) }`,
    expectRed: '摘要過長被拒絕而非截斷',
    why: '**超長的摘要截斷後採納。** 截斷後的摘要看起來是完整的，而它的結尾從未抵達。',
  },
  {
    name: 'reopen-before-settle',
    file: 'src/shared/lineage/lifecycle.ts',
    command: 'test',
    from: `  if (!completion.settled) return wait === 'ready' ? { ...completion, settled: true } : completion`,
    to: `  if (!completion.settled) return wait === 'ready' ? { ...completion, settled: true } : wait === 'busy' ? { ...completion, reopenedAt: now } : completion`,
    expectRed: '報告之後的收尾不推翻完成：忙碌、再就緒 ⇒ 仍為已完成',
    why: '**報告之後的第一次忙碌就算重新開始。** 子 agent 寫完報告通常還會回送訊息（一次工具呼叫）——\n'
      + '> 每一份報告都會被它自己的收尾推翻。',
  },
  {
    name: 'settle-by-transition',
    file: 'src/main/handoff-completion.ts',
    section: 'runCompletion',
    from: `      const next = onWaitTick(current, snapshot.state, this.#now())`,
    to: `      const next = onWaitTick(current, snapshot.state === 'ready' && lastWait === 'ready' ? 'unknown' : snapshot.state, this.#now())`,
    expectRed: '報告於 agent 已停下之後才被採納：其後的忙碌 ⇒ 進行中',
    why: '**落定改依「轉變為就緒」。** agent 停下之後報告才被讀到時，狀態不會再「成為」就緒 —— 永遠不落定，\n'
      + '> 其後的追問整段都顯示已完成（design D6）。',
  },
  {
    name: 'close-without-recheck',
    file: 'src/renderer/src/shell/terminal/lifecycle.tsx',
    section: 'runCompletion',
    from: `              for (const sessionId of closableNow(listed, isDoneNow)) sessions.close(sessionId)`,
    to: `              for (const sessionId of listed) sessions.close(sessionId)`,
    expectRed: '確認前重新開始的 session 與對話框開啟期間才完成的 session 都不被關閉（經畫面確認）',
    why: '**確認時不重新判定。** 對話框開著的期間重新開始的 session 被關掉 —— 關閉 pty 不可逆。',
  },
  {
    name: 'close-all-current',
    file: 'src/renderer/src/shell/terminal/lifecycle.tsx',
    section: 'runCompletion',
    from: `              for (const sessionId of closableNow(listed, isDoneNow)) sessions.close(sessionId)`,
    to: `              for (const sessionId of sessions.all().map((s) => s.id).filter(isDoneNow)) sessions.close(sessionId)`,
    expectRed: '確認前重新開始的 session 與對話框開啟期間才完成的 session 都不被關閉（經畫面確認）',
    why: '**確認時關掉「此刻所有已完成的」。** 對話框開著的期間才完成、使用者根本沒看到的 session 被關掉。',
  },
  // ── handoff-lineage ─────────────────────────────────────────────────────────
  {
    name: 'ticket-reusable',
    file: 'src/main/handoff-ticket.ts',
    command: 'test',
    from: `    this.#entries.delete(token)
    if (spawnTarget !== 'claude' || folderId !== entry.folderId) return null`,
    to: `    if (spawnTarget !== 'claude' || folderId !== entry.folderId) return null`,
    expectRed: '同一張用兩次，第二次無效',
    why: '**憑證用過不作廢。** 同一則交接就能被重複引用、長出任意多個「子 session」—— 那正是不讓 renderer 直接交 intake 主鍵的理由。',
  },
  {
    name: 'ticket-any-state',
    file: 'src/main/handoff-ticket.ts',
    command: 'test',
    from: `  if (!record?.content?.verified.source || record.state !== 'pending') return undefined`,
    to: `  if (!record?.content?.verified.source) return undefined`,
    expectRed: '已接受（含已了結）不簽發 —— 歷史上的交接不能再長出子 session',
    why: '**對任何狀態的 record 都簽發。** record 永不刪除、了結之後仍是 accepted，於是一則歷史上的交接隨時都能再產生子 session。',
  },
  {
    name: 'lineage-after-spawn',
    file: 'src/main/session-create.ts',
    command: 'test',
    from: `  sessions.addProvisional({ id: sessionId, folderId, spawnTarget: target, lineage, peerName })

  let result: R
  try {
    result = await input.spawn(sessionId, peerName)`,
    to: `  let result: R
  try {
    result = await input.spawn(sessionId, peerName)
    sessions.addProvisional({ id: sessionId, folderId, spawnTarget: target, lineage, peerName })`,
    expectRed: 'spawn 的那一刻，暫定紀錄已含來源與名字',
    why: '**關係與名字在 spawn 之後才寫入。** 自我介紹與關係檔在 spawn 時寫出 —— 子 session 的 agent 第一次被注入時看不到母 session，也不知道自己叫什麼。這正是被否決的「在 attach 時寫入」的形狀。',
  },
  {
    name: 'lineage-from-renderer',
    file: 'src/main/session-store.ts',
    command: 'test',
    from: `        lineage: kept?.lineage,`,
    to: `        lineage: (entry as PersistedSession).lineage ?? kept?.lineage,`,
    expectRed: 'renderer 送來的關係與名字被忽略',
    why: '**`replace()` 採信 renderer 送來的關係。** 一個被入侵或有 bug 的 renderer 就能讓任意兩個 session 成為母子 —— agent 會把訊息送給錯的對象。',
  },
  {
    name: 'unknown-as-global',
    file: 'src/main/handoff-service.ts',
    command: 'test',
    from: `    origin: !source
      ? { kind: 'unknown' }`,
    to: `    origin: !source
      ? { kind: 'global' }`,
    expectRed: '來源：攝入時已結束 ⇒ 未知（不是全域），沒有快照',
    why: '**「來源已結束」記成全域。** 使用者會看到「來自 Global」，而那個 session 從來不是全域的 —— 三態歸屬要防的正是這個。',
  },
  {
    name: 'source-unvalidated-on-load',
    file: 'src/main/intake-store.ts',
    command: 'test',
    from: `      content: isContent(content) ? withSafeSource(content) : null,`,
    to: `      content: isContent(content) ? content : null,`,
    expectRed: '載入時丟棄不合法的來源（識別碼不是 UUID），record 保留',
    why: '**載入收件匣時不驗來源。** 一個不合法的識別碼會被寫進子 session，在記憶體裡活到重啟才被 `parseSessionEntry` 丟掉 —— 關係靜默消失。',
  },
  {
    name: 'relations-skip-provisional',
    file: 'src/main/handoff-relations.ts',
    command: 'test',
    from: `  const live = world.view.filter(exists)`,
    to: `  const live = world.view.filter((entry) => !entry.provisional).filter(exists)`,
    expectRed: '新的子 session 一出現（尚未被持久化），母 session 的檔就含它',
    why: '**關係只算已被 renderer 持久化的 session。** 新子 session 在最初 ~500ms 對母 session 不可見 —— 而子 session 的第一次注入正好落在那段時間裡。',
  },
  {
    name: 'siblings-include-self',
    file: 'src/main/handoff-relations.ts',
    command: 'test',
    from: `        .filter((entry) => entry.session.id !== selfId && entry.session.lineage?.parentId === lineage.parentId)`,
    to: `        .filter((entry) => entry.session.lineage?.parentId === lineage.parentId)`,
    expectRed: '兄弟不含自己；關閉的兄弟不列',
    why: '**兄弟清單含自己。** agent 會以為有一個與自己同名的兄弟，而送給它的訊息會送回自己。',
  },
  {
    name: 'siblings-need-parent',
    file: 'src/main/handoff-relations.ts',
    command: 'test',
    from: `  const siblings = lineage
`,
    to: `  const siblings = lineage && byId.has(lineage.parentId)
`,
    expectRed: '母 session 關閉之後兄弟仍互列',
    why: '**母 session 關閉之後兄弟互相看不見。** 它們協作的那件事並沒有因為母 session 收工而結束。',
  },
  {
    name: 'intro-refresh-drops-name',
    file: 'src/main/handoff-injection.ts',
    command: 'test',
    from: `      name: nameOf(sessionId),
      relations: relationsFile(sessionId),`,
    to: ``,
    expectRed: 'folder 清單變動後重寫的自我介紹仍含名字與關係檔位置',
    why: '**folder 清單一變，自我介紹就被重寫成不含名字的版本。** 下一次續接、壓縮、清除時 agent 就不知道自己叫什麼、關係檔在哪裡。',
  },
  {
    name: 'intro-refresh-drops-report',
    file: 'src/main/handoff-injection.ts',
    command: 'test',
    from: `      reportable: reportableOf(sessionId),`,
    to: ``,
    expectRed: 'folder 清單變動後重寫的自我介紹仍含完成報告的說明',
    why: '**folder 清單一變，子 session 的自我介紹就被重寫成不含完成回報的版本。** 下一次續接、壓縮、\n'
      + '> 清除之後子 agent 就不知道要回報，那個 session 永遠停在「等你」，而沒有任何東西會紅。',
  },
  {
    name: 'name-needs-injection',
    file: 'src/main/terminal.ts',
    command: 'test',
    from: `  const name = peerName ? \` --name="$\${PEER_NAME_ENV}"\` : ''`,
    to: `  const name = peerName && injection ? \` --name="$\${PEER_NAME_ENV}"\` : ''`,
    expectRed: '注入功能全部關閉時仍帶名字',
    why: '**名字跟著其他注入走。** 那些功能全關時 `composeInjection` 回 `null`，名字跟著消失 —— 而規格要求名字一律啟用。',
  },
  {
    name: 'name-in-command',
    file: 'src/main/terminal.ts',
    command: 'test',
    from: `  const name = peerName ? \` --name="$\${PEER_NAME_ENV}"\` : ''`,
    to: `  const name = peerName ? \` --name=\${peerName}\` : ''`,
    expectRed: '名字經環境變數交給 claude，不拼進命令字串',
    why: '**名字直接拼進命令字串。** 它含 folder 名稱，而那是使用者檔案系統上的任意字串 —— 其中的 `$(...)` 會被 login shell 執行。',
  },
  {
    name: 'env-not-stripped',
    file: 'src/main/terminal.ts',
    command: 'test',
    from: `    if (key.startsWith('SPEKTERM_')) delete env[key]`,
    to: `    if (key.startsWith('SPEKTERM_NEVER_')) delete env[key]`,
    expectRed: '外層的 SPEKTERM_* 不進入 pty 的環境',
    why: '**不剝除外層的 `SPEKTERM_*`。** 在另一個 spekterm 的 session 裡啟動的 spekterm（開發時的常態），其 agent 會拿到外層仍在執行的那個名字。',
  },
  {
    name: 'no-wait-previous-pty',
    file: 'src/main/terminal.ts',
    command: 'test',
    from: `    await previousExited(sessionId)
`,
    to: `
`,
    expectRed: '同一個 session 的前一顆 pty 結束之前，不啟動新的',
    why: '**不等前一顆 pty 結束。** renderer 重新載入時舊的 agent 還活著，兩個同名行程並存 —— 以那個名字送出的訊息可能送進即將被終止的那一個。',
  },
  {
    name: 'exited-parent-exists',
    file: 'src/shared/lineage/existence.ts',
    command: 'test',
    from: `  if (!input.inList || input.exited || !input.folderInWorkspace) return false`,
    to: `  if (!input.inList || !input.folderInWorkspace) return false`,
    expectRed: '存在的判定：行程已結束而分頁仍在',
    why: '**已結束的 session 仍算存在。** 畫面會把子 session 縮排在一個 agent 看來已經不在的母 session 之下。',
  },
  {
    name: 'cycle-hidden',
    file: 'src/renderer/src/shell/session-forest.ts',
    command: 'test',
    from: `    if (parent !== undefined && !cyclic) parentOf.set(item.id, parent)`,
    to: `    if (parent !== undefined) parentOf.set(item.id, parent)`,
    expectRed: '互為來源與自指的 session 都被呈現（環上的為根）',
    why: '**不偵測環。** 互為來源的兩個 session 沒有一個是根，DFS 從根出發永遠走不到它們 —— 它們靜默地從 rail 消失。',
  },
  {
    name: 'cycle-hidden-probe',
    file: 'src/renderer/src/shell/session-forest.ts',
    section: 'runLineageDrag',
    from: `    if (parent !== undefined && !cyclic) parentOf.set(item.id, parent)`,
    to: `    if (parent !== undefined) parentOf.set(item.id, parent)`,
    expectRed: '互為來源的兩個 session 皆呈現於 rail',
    why: '**同一個 mutation，被出貨的那份程式碼上的載體。**',
  },
  {
    name: 'move-single-node',
    file: 'src/renderer/src/shell/session-forest.ts',
    command: 'test',
    from: `  const sequence = next.flatMap((sibling) => blockOf(forest, sibling))`,
    to: `  const sequence = [...next]`,
    expectRed: '帶子孫往下拖：P（帶 C）、X、Y ⇒ X、Y、P、C',
    why: '**只移動被拖的那一個節點，不帶子孫。** 子 session 留在原地，分頁列裡它與母 session 被拆開。',
  },
  {
    name: 'move-single-node-probe',
    file: 'src/renderer/src/shell/session-forest.ts',
    section: 'runLineageDrag',
    from: `  const sequence = next.flatMap((sibling) => blockOf(forest, sibling))`,
    to: `  const sequence = [...next]`,
    expectRed: '於 rail 往下拖曳帶有子孫的 session：子孫一起移動',
    why: '**同一個 mutation，被出貨的那份程式碼上的載體**（真滑鼠拖曳、真的 rail）。',
  },
  {
    name: 'place-after-last-descendant',
    file: 'src/renderer/src/shell/session-forest.ts',
    command: 'test',
    from: `  const block = new Set(blockOf(forest, parentId))`,
    to: `  const block = new Set(blockOf(forest, parentId).slice(1))`,
    expectRed: '子孫被拖到母節點之前時，仍放在母節點之後',
    why: '**以「最後一個子孫」而不是「母節點與其子孫中最後的那一個」為準。** 分頁列曾把子孫拖到母節點之前時，新的子 session 落在母節點之前。',
  },
  {
    name: 'tree-ignores-lineage',
    file: 'src/renderer/src/shell/WorkspaceRail.tsx',
    section: 'runLineage',
    from: `    sessions.map((session) => ({ id: session.id, parentId: session.lineage?.parentId })),`,
    to: `    sessions.map((session) => ({ id: session.id, parentId: undefined })),`,
    expectRed: '同一個 folder 中的子 session 縮排於母 session 之下',
    why: '**rail 不看關係，全部平鋪。** 使用者分不出哪個 session 是誰交接出來的 —— 這個 change 要解的就是這個。',
  },
]

function run(names) {
  const selected = names.length > 0 ? MUTATIONS.filter((m) => names.includes(m.name)) : MUTATIONS
  if (selected.length === 0) {
    console.error(`不認得的名稱。可用：${MUTATIONS.map((m) => m.name).join(', ')}`)
    process.exit(1)
  }

  const failures = []
  for (const mutation of selected) {
    const full = join(repoRoot, mutation.file)
    const original = readFileSync(full, 'utf8')
    if (!original.includes(mutation.from)) {
      failures.push(`${mutation.name}：找不到要替換的片段（原始碼已經變了？）`)
      continue
    }
    const mutated = original.replace(mutation.from, mutation.to)
    // **先證明 mutation 真的改到了東西。**
    if (mutated === original) {
      failures.push(`${mutation.name}：替換之後內容沒有改變 —— 這個對照組本身是假的`)
      continue
    }

    console.log(`\n── ${mutation.name} ──\n${mutation.why}\n預期變紅：${mutation.expectRed}`)
    writeFileSync(full, mutated)
    let output
    try {
      // **有些 mutation 的載體是單元測試而不是 probe**，而那不是瑕疵：一條「決策層在什麼
      // 時候做了什麼」的性質，在 probe 的一次操作裡表達不出來（畫面上看不到那個決策）。
      // 指名錯載體的代價是一個**紅不起來的對照組** —— 那比沒有對照組更糟，因為它看起來有人管。
      const command = mutation.command === 'test' ? ['test'] : ['run', 'probe:intake']
      /**
       * **`section` 讓對照組只跑那一段。**
       *
       * 跑全套是八倍的時間，而鑑別力一分不差 —— 只要那條 `expectRed` 的斷言確實住在該段。
       * 指名錯段落的代價與指名錯載體相同：一個紅不起來的對照組。
       */
      output = execFileSync('npm', command, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15 * 60_000,
        ...(mutation.section ? { env: { ...process.env, PROBE_ONLY: mutation.section } } : {}),
      })
    } catch (error) {
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    } finally {
      writeFileSync(full, original)
    }

    // probe 的紅是 `✗ <斷言>`，node:test 的紅是 `not ok N - <測試名>` —— 兩種格式都認。
    // **node:test 的紅燈必須整行比對。** 它的 TAP 對每一個子測試都印出名稱 ——
    // 通過的是 `    ok N - <名稱>`、失敗的是 `    not ok N - <名稱>`，而且**是縮排的**。
    // 因此 `includes(expectRed)` 會對「那條測試通過、但檔案裡別的測試失敗」一併成立，
    // 而 `/^not ok/m` 只匹配得到最外層那一行（它是**檔案**層級的，不帶測試名）。
    // 兩者相乘的結果是：只要檔案裡有任何一條紅，指名任何一條測試都會被判成「如預期變紅」。
    const notOkLine = new RegExp(
      `^\\s*not ok \\d+ - ${mutation.expectRed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
      'm',
    )
    const wentRed =
      output.includes(`✗ ${mutation.expectRed}`) ||
      (mutation.command === 'test' && notOkLine.test(output))
    console.log(wentRed ? `  ✓ 如預期變紅` : `  ✗ **沒有變紅** —— 那條斷言沒有鑑別力`)
    if (!wentRed) failures.push(`${mutation.name}：${mutation.expectRed} 沒有變紅`)
  }

  // 還原之後重建一次，讓 `out/` 回到未被 mutate 的狀態。
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'ignore' })

  if (failures.length > 0) {
    console.error(`\n${failures.length} 個對照組未通過：`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log(`\n${selected.length} 個對照組全部如預期變紅。`)
}

// **只有被直接執行時才跑。** 守衛（`control-groups-source.test.mjs`）要 import `MUTATIONS`，
// 而一個在 import 時就開跑的模組會讓 `npm test` 變成十幾分鐘的完整對照組。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2))
}
