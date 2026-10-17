/**
 * `probe:slack` 的對照組 —— 把修正退回，確認那條斷言真的變紅。
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
 * 用法：`node scripts/slack-control-groups.mjs [名稱…]`
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
  {
    name: 'thread-upper-bound-now',
    file: 'src/main/slack-backfill.ts',
    from: `  const upTo = result.value.messages.filter(
    (message) => Number(message.ts) <= Number(candidate.message.ts),
  )`,
    to: `  const upTo = result.value.messages`,
    expectRed: '提及**之後**的回覆不進本文（上界固定於被提及的那一則）',
    why: '**討論串的上界改為「取回當下」。** design D3(a) 的整條論證建立在那個上界固定於訊息座標 ——'
      + '少了它，同一則提及在不同時間被重新推導會產生不同的本文。\n'
      + '> 這個 mutation 之所以會讓「帶入之前的上下文」變紅並不直覺：替身的討論串裡有一則**晚於**'
      + '提及的訊息，而它被納入之後卡片的文字就與斷言期待的不同。**指名的斷言必須是實際會紅的那一條**，'
      + '不是「聽起來相關的那一條」。',
  },
  {
    name: 'dedup-cursor-only',
    file: 'src/main/slack-backfill.ts',
    from: `  if (deps.alreadyDelivered(id)) return { delivered: false }`,
    to: `  // mutation：去重改成只看自己的水位`,
    expectRed: '不產生面向使用者的拒絕或警示（含收件匣的拒絕彙整）',
    why: '**去重的權威改回本能力自己的水位。**'
      + '\n> **指名的斷言是「拒絕彙整」而不是卡片張數**（實測）：內容相同的重投會被收件匣'
      + '**靜默**吞掉，卡片仍是一張 —— 卡片張數那條紅不起來。替身在第二輪改了發話者的名字，'
      + '於是內容不同 ⇒ 收件匣跳「識別碼搶佔」⇒ 拒絕彙整出現。而它渲染在 notices 那一條，'
      + '**不在 li 裡**，所以斷言必須讀整個 overlay。\n'
      + '會觸發重新推導的主要原因正是水位遺失 ——'
      + '那時任何與它同居的紀錄一併遺失。design D3(b) 的第一版就是那個形狀，實作時才發現它'
      + '保護不了促使它存在的情境。',
  },
  {
    name: 'truncation-marker-outside-body',
    file: 'src/main/slack-mention.ts',
    from: '  return `${marker}\\n${tail}`',
    to: '  return tail',
    expectRed: '截斷的說明出現在本文之內',
    why: '**截斷標記不寫進 `body`。** 本文是唯一「呈現給使用者的那一份逐字元就是交給 agent 的'
      + '那一份」的欄位 —— 標記放在別處，使用者讀到「這裡被截斷了」而 agent 讀不到，'
      + '兩者對「我看到的是全部嗎」得到相反的答案。',
  },
  {
    name: 'truncate-body-only',
    file: 'src/main/slack-mention.ts',
    from: `  if (normalized.length <= MAX_FIELD_LENGTH) return normalized`,
    to: `  return normalized`,
    expectRed: '過長的討論串與標題都不使整則被拒絕',
    why: '**只截斷本文，不截短欄位。** `MAX_FIELD_LENGTH` 是 200，而 Slack 訊息的第一行很容易'
      + '超過 —— 症狀是某些提及**永遠進不了收件匣**，而使用者只看到一則看不懂的拒絕。'
      + '第一版 design 只論證了 body，那個缺口的形狀與它要修的是同一個。',
  },
  {
    name: 'lookback-ignored',
    file: 'src/main/slack-backfill.ts',
    from: '  return `${Math.max(0, seconds)}.000000`',
    to: "  return '0.000000'",
    expectRed: '回看範圍之外的提及不出現',
    why: '**忽略回看範圍。** 這條 mutation 同時證明了替身真的在套用 `oldest` ——'
      + '替身不篩的話，產品忽略回看範圍也不會讓任何東西變紅（那是一組假綠的組合）。',
  },
  {
    name: 'id-thread-scoped',
    file: 'src/main/slack-mention.ts',
    from: '  return `slack:${input.teamId}:${input.channelId}:${input.ts}`',
    to: '  return `slack:${input.teamId}:${input.channelId}`',
    command: 'test',
    expectRed: '同一討論串的兩次提及產生相異識別碼',
    why: '**識別碼改為頻道層級（模擬 thread-scoped 的形狀）。** 同一頻道的第二則提及會與第一則'
      + '共用識別碼而靜默消失。\n'
      + '> **這條的載體是單元測試，不是 probe**（實測）：probe 的 fixture 在那個頻道只有**一則**'
      + '提及，而頻道層級的識別碼跟自己不會撞 —— 兩條 probe 斷言都紅不起來。要看見它需要'
      + '同一頻道的兩則提及，而那是單元測試在做的事。**指名錯載體的對照組比沒有對照組更糟**，'
      + '因為它看起來有人管。',
  },
  {
    name: 'endpoint-warning-removed',
    file: 'src/renderer/src/shell/settings/sections/IntegrationsSection.tsx',
    from: `          {state.usesDefaultEndpoint ? t('slack.endpointDefault') : t('slack.endpointCustom')}`,
    to: `          {t('slack.endpointDefault')}`,
    expectRed: '端點非預設值時畫面上明確警示',
    why: '**端點非預設值時不警示。** 憑證的目的地是一個資料欄位（使用者的裁決），而那個代價'
      + '只有在他看得見時才可接受 —— **一個沉默的端點欄位比沒有這個欄位更糟**。',
  },
  {
    name: 'status-not-pushed',
    file: 'src/renderer/src/shell/settings/sections/IntegrationsSection.tsx',
    from: `  useEffect(() => window.workspace.slack.onChanged(reload), [reload])`,
    to: `  // mutation：不訂閱狀態改變`,
    expectRed: '憑證失效時使用者看得到，且說明重試無用',
    why: '**狀態只在掛載時取一次。** 回補在啟動數秒後才跑完，於是使用者看到的永遠是'
      + '「還沒檢查過」，而憑證失效**永遠不會出現在畫面上** —— D10 那條 requirement 會以一個'
      + '看起來正常的介面失敗。\n'
      + '> **這正是 `probe:slack` 第一次跑就抓到的那個真缺陷**，這條 mutation 是它的回歸。',
  },
  {
    name: 'auth-merged-into-transient',
    file: 'src/main/slack-api.ts',
    from: `  if (AUTH_ERRORS.has(error)) return { kind: 'auth', error }`,
    to: `  if (false) return { kind: 'auth', error }`,
    expectRed: '憑證失效時使用者看得到，且說明重試無用',
    why: '**把憑證問題併進暫時性失敗。** 使用者會看到「稍後會再試一次」而那永遠不會成功 ——'
      + '重試無用這件事必須說出來。順帶：報成 transient 也會讓即時路徑不被跳過。',
  },
  {
    name: 'failure-not-merged',
    file: 'src/main/slack-service.ts',
    from: `      return { ...current, count: current.count + 1, needed: needed ?? current.needed }`,
    to: `      return { kind: failure.kind, error: failure.error, count: 1, needed }`,
    command: 'test',
    expectRed: '**同一種失效合併為恰好一則，且帶次數**',
    why: '**同一種失效不累加次數。** \n'
      + '> **這條的載體是單元測試，不是 probe**（實測）：probe 只觸發一輪失效，於是畫面上顯示'
      + '「seen once」，而那仍然滿足 `/seen (once|\\d+ times)/`。**probe 那條斷言在這個 mutation'
      + '之下紅不起來** —— 要兩輪失效才看得出「沒有累加」，而那是單元測試在做的事。',
  },
  {
    name: 'rate-limit-keeps-scanning',
    file: 'src/main/slack-backfill.ts',
    from: `      if (rateLimited) break
      continue`,
    to: `      continue`,
    expectRed: '被要求稍後再試之後，該輪不再詢問其餘頻道',
    why: '**被拒的那個頻道跳過之後繼續問下一個。** 那些請求註定帶不回任何東西，'
      + '而它們正是讓拒絕延長的原因。\n'
      + '> **指名的必須是「恰為 2 次」那一條，不是「不等於頻道總數」那一條**（實測踩過）：'
      + '這個 mutation 只拿掉迴圈內的中止，底部那個還在，於是呼叫數是 **3** —— '
      + '「≠ 4」仍然成立，紅不起來。那條斷言的對照組是下一個 mutation。',
  },
  {
    name: 'rate-limit-never-aborts',
    file: 'src/main/slack-backfill.ts',
    from: `      rateLimited = true`,
    to: `      rateLimited = false`,
    expectRed: '而那個次數確實不等於頻道總數（否則中止與跑完分不出來）',
    why: '**中止整個不發生**（兩個 break 同時失效）。這是「≠ 頻道總數」那條斷言存在的理由：'
      + '呼叫數回到 4，而那正是「跑完了全部頻道」的樣子。\n'
      + '> 與上一個 mutation 成對：**一個驗「中止的位置對不對」，一個驗「中止有沒有發生」。**',
  },
  {
    name: 'rate-limit-no-gate',
    file: 'src/main/slack-service.ts',
    from: `      if (this.#now() < this.#retryAt) {`,
    to: `      if (false) {`,
    command: 'test',
    expectRed: '**退避期內的每一次觸發都不跑，期滿之後的會跑**',
    why: '**拿掉跨輪的閘。** 對端說「等 10 分鐘」，而我們每 5 分鐘照敲一次。\n'
      + '> 載體只能是單元測試：探針驗不了「下一輪何時發生」—— 那要等五分鐘。',
  },
  {
    name: 'rate-limit-never-clears',
    file: 'src/main/slack-service.ts',
    from: `      if (this.#now() < this.#retryAt) {`,
    to: `      if (true) {`,
    command: 'test',
    expectRed: '**退避期內的每一次觸發都不跑，期滿之後的會跑**',
    why: '**退避之後永遠不再取回** —— 與上一條方向相反。那條斷言的後半句（「期滿之後要恢復」）'
      + '正是為了這個方向而寫的。\n'
      + '> 少了後半句，這個 mutation 全綠，而畫面上只是一直顯示「正在等待」。',
  },
  {
    name: 'retry-after-unclamped',
    file: 'src/main/slack-service.ts',
    from: `  return Math.min(Math.max(retryAfterSeconds, BACKOFF.minSeconds), BACKOFF.maxSeconds)`,
    to: `  return Math.max(retryAfterSeconds, BACKOFF.minSeconds)`,
    command: 'test',
    expectRed: '**荒謬的值被夾住** —— 端點是使用者可設定的，那個值不是完全可信的輸入',
    why: '**拿掉上界。** 端點是使用者可設定的，一個回 `Retry-After: 99999999` 的端點會讓這個'
      + '能力無限期停擺，而畫面上只會顯示「正在等待」。',
  },
  {
    name: 'rate-limit-parasitic-field',
    file: 'src/main/slack-backfill.ts',
    from: `    if (found.kind === 'rate_limited') {
      rateLimited = true
      retryAfterSeconds ??= found.retryAfterSeconds
    }`,
    to: `    if (failure.kind === 'rate_limited') {
      rateLimited = true
      retryAfterSeconds ??= failure.retryAfterSeconds
    }`,
    command: 'test',
    expectRed: '**速率上限不被先到的其他失敗遮掉**',
    why: '**把退避資訊改回寄生在 `failure` 上。** `failure` 是「先到的贏」——'
      + '一個更早的網路錯誤會讓 429 永遠讀不到，而症狀只是「偶爾沒有退避」，沒有任何東西會紅。',
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
      // **有些 mutation 的載體是單元測試而不是 probe**，而那不是瑕疵：一條需要「兩輪失效」
      // 或「兩條路徑比對」的性質，在 probe 的一次操作裡表達不出來。指名錯載體的代價是
      // 一個紅不起來的對照組 —— 那比沒有對照組更糟，因為它看起來有人管。
      const command = mutation.command === 'test' ? ['test'] : ['run', 'probe:slack']
      output = execFileSync('npm', command, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15 * 60_000,
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
