/**
 * slack-intake-source / secret-scope 的驗收。
 *
 * ## 這支探針存在的理由
 *
 * 主行程的單元測試看不見兩件事：
 *
 * 1. **一則 Slack 提及真的變成收件匣裡的一張卡片**（而不是「某個函式回了一個正確的物件」）。
 * 2. **狀態在畫面上分得出來** —— 「憑證失效」與「目前沒有待處理項目」在外部本來是同一個
 *    樣子（收件匣是空的），而使用者分不出來就會在一件已經壞掉的事情上繼續等。
 *
 * ## 接縫是產品的端點設定
 *
 * 替身是**真的 HTTPS 伺服器**（`lib/stub-slack.mjs`），因為產品的端點白名單只認 `https:` ——
 * 而不是把那條白名單為了驗收放寬。信任錨以 `NODE_EXTRA_CA_CERTS` 交給 app（實測：
 * `--ignore-certificate-errors` 無效，因為主行程的 `fetch` 走 undici 而非 Chromium 的堆疊）。
 *
 * ## 刻意不涵蓋
 *
 * - **真實 Slack 的連線**（要網路、要憑證、回應不可重現）—— 規格已宣告未涵蓋，由 dogfood 認定。
 * - **即時路徑收得到事件**：替身回一個連不上的 wss 位址，於是只驗得到「降級」那一半。
 *   要驗另一半得起一個 wss 伺服器並實作 Socket Mode 的信封協定，缺口登記在規格裡。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, connectToApp, pollFor } from './lib/cdp.mjs'
import { copy, copyIn, label } from './lib/copy.mjs'
import { electronExtraArgs } from './lib/display.mjs'
import { awaitMounted } from './lib/mounted.mjs'
import { PROBE_PORTS, STUB_PORTS } from './lib/ports.mjs'
import { runSections } from './lib/sections.mjs'
import { seedLanguage } from './lib/probe-language.mjs'
import { SETTINGS_DIALOG, clickSelector, openSettings, showSection } from './lib/settings.mjs'
import {
  STUB_CHANNEL_NAME,
  seedSlackSettings,
  seedSlackToken,
  startStubSlack,
  stubMention,
  stubMessage,
} from './lib/stub-slack.mjs'

const PORT = PROBE_PORTS.slack.main
const RESTART_PORT = PROBE_PORTS.slack.restart
const STUB_PORT = STUB_PORTS.slack

const results = []
const temps = []

function mkTemp(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temps.push(dir)
  return dir
}

/**
 * 一個帶單一 folder 的 profile，且 routing 的 fallback 指向它（否則每一則都解析不出 folder）。
 * `fallback: false` leaves the fallback unset: Settings' Integrations hint shows only then.
 */
function seedProfile({ fallback = true } = {}) {
  const profile = mkTemp('spekterm-slack-profile-')
  const repo = mkTemp('spekterm-slack-repo-')
  const folderId = '11111111-1111-4111-8111-111111111111'
  writeFileSync(
    join(profile, 'workspace.json'),
    // `addedAt` is required (`workspace-store.ts`): without it the file is judged corrupt and set aside, and the
    // app starts with no folder at all — which this probe did, unseen, until a check needed the folder.
    `${JSON.stringify({ version: 1, folders: [{ id: folderId, path: repo, addedAt: new Date().toISOString() }] }, null, 2)}\n`,
    'utf8',
  )
  mkdirSync(join(profile, 'intake-inbox'), { recursive: true })
  writeFileSync(
    join(profile, 'intake-routing.json'),
    // The routing file's own shape (`intake-routing.ts`): rules and fallback at the top level. This probe once
    // nested them under `routing`, which the store ignores, so no fallback was ever set; nothing showed it while
    // the routing hint was static text.
    `${JSON.stringify({ version: 1, rules: [], fallbackFolderId: fallback ? folderId : null }, null, 2)}\n`,
    'utf8',
  )
  return { profile, repo, folderId }
}

async function launch({ profile, env, port = PORT }) {
  // 被測 app 的語言是**被指定的**：全新的 profile 會觸發首次啟動的語言偵測，
  // 而在一台非英文的機器上，那會讓每一條 `aria-label` 選擇器選不到元素。
  // 既有的 `preferences.json` 不動（損毀韌性與舊檔那兩段自己佈置它）。
  seedLanguage(profile)

  const child = spawn(
    'electron',
    [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...electronExtraArgs(), '.'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh', ...env } },
  )
  let output = ''
  child.stderr?.on('data', (chunk) => (output += chunk))
  child.stdout?.on('data', (chunk) => (output += chunk))
  const client = await connectToApp(port, { targetTimeoutMs: 30_000 })
  await awaitMounted(client)
  return {
    client,
    output: () => output,
    async close() {
      try {
        await client.close()
      } catch {
        // 已經斷了就算了 —— 收屍才是重點。
      }
      child.kill()
      await new Promise((resolve) => setTimeout(resolve, 900))
    },
  }
}

const SLACK_PANEL = `document.querySelector(${JSON.stringify(`${SETTINGS_DIALOG} ${label('slack.title')}`)})`
const INBOX = `[role="dialog"]${label('intake.label')}`
const inboxOpen = (app) => app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(INBOX)}))`)

/**
 * Opens Settings on its Integrations section, where the Slack connection is edited (`settings-sections`). It used
 * to be the inbox's third tab. The inbox sits above Settings, so it is closed first.
 */
async function openSlackTab(app) {
  if (await inboxOpen(app)) {
    await app.client.evaluate(`document.querySelector(${JSON.stringify(`${INBOX} button${label('intake.close')}`)})?.click()`)
    await pollFor({ read: async () => !(await inboxOpen(app)), settled: Boolean, timeoutMs: 10_000, label: '收件匣關閉' })
  }
  await openSettings(app.client, 'integrations')
  await pollFor({
    read: () => app.client.evaluate(`!!${SLACK_PANEL}`),
    settled: Boolean,
    timeoutMs: 15_000,
    label: 'Settings › Integrations 呈現',
  })
}

/** Opens the inbox on its Inbox tab; the activity bar entry closes Settings first. */
async function openInboxTab(app) {
  if (!(await inboxOpen(app))) {
    await app.client.evaluate(
      `(() => { document.querySelector(${JSON.stringify(label('activityBar.handoffs'))})?.click(); return true })()`,
    )
    await pollFor({ read: () => inboxOpen(app), settled: Boolean, timeoutMs: 15_000, label: '收件匣 overlay 開啟' })
  }
  await app.client.evaluate(
    `(() => {
      const tabs = [...document.querySelectorAll(${JSON.stringify(`${INBOX} [role="tab"]`)})]
      tabs.find((tab) => (tab.textContent ?? '').trim() === ${JSON.stringify(copy('intake.title'))})?.click()
      return true
    })()`,
  )
}

const slackText = (app) => app.client.evaluate(`(${SLACK_PANEL}?.textContent ?? '')`)

/**
 * 整個收件匣 overlay 的文字。
 *
 * **必須有這一個，卡片文字不夠**：重複交付時收件匣會跳「識別碼搶佔」的拒絕彙整，而它渲染在
 * notices 那一條（一個 div），**不在 `li` 裡**。只看卡片的話，「去重完全沒做」這個錯誤實作
 * 照樣綠 —— 因為內容相同的重投會被收件匣靜默吞掉，卡片仍是一張。
 * （實測：對照組 `dedup-cursor-only` 與 `id-thread-scoped` 第一版都紅不起來。）
 */
const overlayText = (app) =>
  app.client.evaluate(`(document.querySelector('[role="dialog"]')?.textContent ?? '')`)
const inboxText = (app) =>
  app.client.evaluate(`[...document.querySelectorAll('li')].map((n) => n.textContent ?? '').join('\\n')`)

/**
 * 含某段文字的**卡片張數**。
 *
 * **不能數子字串的出現次數** —— 一則提及的文字同時出現在標題與本文裡（同一張卡片），
 * 於是「出現兩次」對一個完全正確的實作也成立。第一版就是那樣寫的，紅的是測試不是產品。
 */
const cardCount = (app, needle) =>
  app.client.evaluate(
    `[...document.querySelectorAll('li')].filter((n) => (n.textContent ?? '').includes(${JSON.stringify(needle)})).length`,
  )

/** 等收件匣出現含某段文字的卡片。 */
async function awaitCard(app, needle) {
  await pollFor({
    read: () => inboxText(app),
    settled: (text) => text.includes(needle),
    timeoutMs: 30_000,
    label: `收件匣出現「${needle}」`,
  })
}

/**
 * 每個段落自己收掉 app 與 stub。
 *
 * **`afterMode` 是每個模式跑一次，不是每個段落。** 靠它收的話第二段會撞
 * `EADDRINUSE`（替身的 port 還被前一段佔著）與「連到還活著的前一個 app」——
 * 後者的症狀是斷言在一個不相干的 profile 上空轉，而它看起來像產品沒有把提及讀進來。
 */
async function withApp(context, { profile, stub, port }, body) {
  const app = await launch({ profile, env: stub.env, port })
  context.app = app
  try {
    await body(app)
  } finally {
    await app.close()
    context.app = null
    await stub.close()
    context.stub = null
  }
}

async function runDelivery(_mode, context) {
  const { profile } = seedProfile()
  const mention = stubMention({ secondsAgo: 60, text: 'ship it' })
  const stub = await startStubSlack({
    port: STUB_PORT,
    state: {
      messages: [mention],
      threads: {
        [mention.ts]: [
          stubMessage({ secondsAgo: 120, text: 'earlier context' }),
          mention,
          // **提及之後的那一則。** 它必須不出現在本文裡 —— 那是 design D3(a)（上界固定於
          // 被提及的那一則）在這一層唯一的載體。少了它，「把上界改成取回當下」這個 mutation
          // 紅不起來（實測：對照組第一版就是那樣）。
          stubMessage({ secondsAgo: 30, text: 'LATER-REPLY' }),
        ],
      },
    },
  })
  seedSlackSettings(profile, { baseUrl: stub.baseUrl })
  seedSlackToken(profile)
  context.stub = stub

  await withApp(context, { profile, stub }, async (app) => {
    await openSlackTab(app)
    await openInboxTab(app)
    await awaitCard(app, 'ship it')

    const cards = await inboxText(app)
    check(results, '一則 Slack 提及成為收件匣的待處理卡片', cards.includes('ship it'), cards.slice(0, 160))
    check(results, '卡片呈現頻道名稱而非識別碼', cards.includes(STUB_CHANNEL_NAME), cards.slice(0, 160))
    check(
      results,
      '卡片呈現發話者的顯示名稱而非 user id',
      cards.includes('stub-mate') && !cards.includes('U0STUBMATE'),
      cards.slice(0, 160),
    )
    check(results, '本文帶入提及之前的上下文', cards.includes('earlier context'), cards.slice(0, 240))
    check(
      results,
      '提及**之後**的回覆不進本文（上界固定於被提及的那一則）',
      !cards.includes('LATER-REPLY'),
      cards.slice(0, 400),
    )

    // **憑證只走 header** —— 替身記下了實際收到的呼叫。
    const authCalls = stub.calls.filter((entry) => entry.method === 'auth.test')
    check(results, '前提：回補確實呼叫了替身', authCalls.length > 0, `auth.test ${authCalls.length} 次`)
    check(
      results,
      '憑證以 Authorization header 送出，不在 body 裡',
      authCalls.every((e) => e.authorization.startsWith('Bearer ') && !e.body.includes('xoxp-')),
      '憑證只出現在 header',
    )
  })
}

/**
 * ui-localization：**已持久化的文字，其語言於寫入當下固定。**
 *
 * Slack 的本文由投遞者的訊息與**我們自己寫的抬頭**組成，而本文是唯一「呈現給使用者的那一份
 * 逐字元就是交給 agent 的那一份」的欄位。它在**攝入的那一刻**組好並存進磁碟，之後不再重算
 * —— 於是使用者以中文介面收下的項目，在他切成英文之後**仍然是中文**。
 *
 * **那是對的**（本文是一份已交付的記錄），但它要求一條明文的禁令：呈現時 SHALL NOT 重新翻譯。
 * 一個「順手在呈現層再 `t()` 一次」的實作會讓畫面變英文而磁碟上還是中文 —— 正是
 * `agent-intake` 那條逐字元不變式在防的分岔，**而它只在使用者改變過語言之後才會出現**：
 * 一輪不曾改變語言的驗收碰不到它，所以這一段自己造出那個動作。
 */
async function runPersistedLanguage(_mode, context) {
  const { profile } = seedProfile()
  // **以中文攝入** —— 抬頭因此是中文的，而它會被寫進本文。
  seedLanguage(profile, { language: 'zh-TW' })

  const mention = stubMention({ secondsAgo: 60, text: 'PERSISTED-BODY' })
  const stub = await startStubSlack({
    port: STUB_PORT,
    state: { messages: [mention], threads: { [mention.ts]: [mention] } },
  })
  seedSlackSettings(profile, { baseUrl: stub.baseUrl })
  seedSlackToken(profile)
  context.stub = stub

  await withApp(context, { profile, stub }, async (app) => {
    await app.client.evaluate(
      `document.querySelector('[aria-label="${copyIn('zh-TW', 'activityBar.handoffs')}"]')?.click()`)

    const zhHeader = copyIn('zh-TW', 'slack.bodyHeader', { channel: STUB_CHANNEL_NAME })
    const bodyInChinese = await pollFor({
      read: () => app.client.evaluate('document.body.textContent ?? \'\''),
      settled: (text) => text.includes('PERSISTED-BODY'),
      timeoutMs: 30_000,
      label: '卡片已呈現',
    }).catch(() => '')
    check(results, '前置：以中文攝入的本文帶著中文的抬頭',
      bodyInChinese.includes(zhHeader), zhHeader)

    // 切成英文 —— 走產品自己的入口。
    await app.client.evaluate(
      `document.querySelector('[aria-label="${copyIn('zh-TW', 'activityBar.settings')}"]')?.click()`)
    await pollFor({
      read: () => app.client.evaluate(
        `document.querySelector('[aria-label="${copyIn('zh-TW', 'settings.language')}"]') !== null`),
      settled: Boolean,
      timeoutMs: 10_000,
      label: '設定對話框開啟',
    })
    await app.client.evaluate(`(() => {
      const select = document.querySelector('[aria-label="${copyIn('zh-TW', 'settings.language')}"]')
      select.value = 'en'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    await pollFor({
      read: () => app.client.evaluate('document.documentElement.lang'),
      settled: (value) => value === 'en',
      timeoutMs: 10_000,
      label: '介面已切成英文',
    })

    const afterSwitch = await app.client.evaluate('document.body.textContent ?? \'\'')
    check(results, '前置：介面確實切成了英文',
      afterSwitch.includes(copy('activityBar.settings')) || afterSwitch.includes(copy('settings.title')),
      afterSwitch.slice(0, 120))
    check(results, '改變語言後，既有項目的本文仍為攝入當下的語言',
      afterSwitch.includes(zhHeader),
      afterSwitch.includes(copy('slack.bodyHeader', { channel: STUB_CHANNEL_NAME }))
        ? '本文被呈現層重新翻譯了 —— 它與磁碟上交給 agent 的那一份已經分岔'
        : afterSwitch.slice(0, 200))
  })
}

async function runAuthFailure(_mode, context) {
  const { profile } = seedProfile()
  const stub = await startStubSlack({ port: STUB_PORT, state: { authFails: true, messages: [] } })
  seedSlackSettings(profile, { baseUrl: stub.baseUrl })
  seedSlackToken(profile)
  context.stub = stub

  await withApp(context, { profile, stub }, async (app) => {
    await openSlackTab(app)
    // **先等主行程真的記下了失效** —— 讀 IPC payload 而不是畫面：分開這兩步之後，
    // 「主行程沒記下」與「畫面沒更新」是兩條不同的紅燈，而它們的處置完全不同。
    const statusJson = () =>
      app.client.evaluate(`window.workspace.slack.get().then((s) => JSON.stringify(s.status))`, {
        awaitPromise: true,
      })
    await pollFor({
      read: statusJson,
      settled: (json) => String(json).includes('"kind":"auth"'),
      timeoutMs: 30_000,
      label: `主行程記下憑證失效（實際：${'${'}await statusJson()}）`.replace('${await statusJson()}', ''),
    })
    check(results, '主行程把憑證失效記成 auth 類', String(await statusJson()).includes('"kind":"auth"'), String(await statusJson()))

    await pollFor({
      read: () => slackText(app),
      settled: (text) => text.includes('no longer valid'),
      timeoutMs: 15_000,
      label: '畫面上呈現憑證失效',
    })
    const text = await slackText(app)
    check(results, '憑證失效時使用者看得到，且說明重試無用', /no longer valid/.test(text), text.slice(0, 200))
    check(
      results,
      '該呈現與「目前沒有待處理項目」可區分',
      !text.includes('Nothing new since'),
      '沒有同時呈現閒置的說法',
    )
    check(results, '失效的呈現帶出現次數（不是逐次各發一則）', /seen (once|\d+ times)/.test(text), text.slice(0, 200))

    // The inbox says it too (`slack-intake-source`, "The inbox says when Slack is not working"): an empty inbox
    // must not look like nobody mentioning the user.
    await openInboxTab(app)
    const OPEN_SLACK = `${INBOX} button`
    const line = await pollFor({
      read: () => app.client.evaluate(`document.querySelector(${JSON.stringify(INBOX)})?.textContent ?? ''`),
      settled: (value) => value.includes(copy('slack.openSettings')),
      timeoutMs: 10_000,
      label: 'the Slack line in the inbox',
    }).catch(() => '')
    check(
      results,
      'a broken connection is stated in the inbox',
      line.includes(copy('slack.openSettings')) && /no longer valid/.test(line),
      line.slice(0, 200),
    )
    await app.client.evaluate(`[...document.querySelectorAll(${JSON.stringify(OPEN_SLACK)})].find((b) => b.textContent.trim() === ${JSON.stringify(copy('slack.openSettings'))})?.click()`)
    const routed = await pollFor({
      read: () =>
        app.client.evaluate(`({
          inbox: Boolean(document.querySelector(${JSON.stringify(INBOX)})),
          integrations: document.querySelector('#settings-tab-integrations')?.getAttribute('aria-selected') === 'true',
        })`),
      settled: (value) => !value.inbox && value.integrations,
      timeoutMs: 10_000,
      label: 'Settings on Integrations, the inbox closed',
    }).catch(() => null)
    check(
      results,
      "the inbox's Slack line opens Settings on Integrations and closes the inbox",
      routed !== null && !routed.inbox && routed.integrations,
      JSON.stringify(routed),
    )
  })
}

/**
 * Settings' Integrations section (`settings-sections`): the save rules of each field, the routing hint, and what
 * the inbox no longer holds. One run, in order: a profile with no Slack token and no routing fallback.
 */
async function runSettingsFields(_mode, context) {
  const { profile, folderId } = seedProfile({ fallback: false })
  const stub = await startStubSlack({ port: STUB_PORT, state: { messages: [] } })
  seedSlackSettings(profile, { baseUrl: stub.baseUrl })
  context.stub = stub

  const state = (app) =>
    app.client
      .evaluate(`window.workspace.slack.get().then((s) => JSON.stringify(s))`, { awaitPromise: true })
      .then((json) => JSON.parse(String(json)))
  const field = (key) => `${SETTINGS_DIALOG} input${label(key)}`
  /** Focus a field with a real click, select its text, and type `text` one character at a time. */
  const typeInto = async (app, key, text) => {
    await clickSelector(app.client, field(key), copy(key))
    await app.client.evaluate(`document.querySelector(${JSON.stringify(field(key))})?.select()`)
    for (const char of text) await app.client.send('Input.insertText', { text: char })
  }
  const press = async (app, key, code, keyCode) => {
    for (const type of ['keyDown', 'keyUp']) {
      await app.client.send('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        ...(type === 'keyDown' && key === 'Enter' ? { text: '\r' } : {}),
      })
    }
  }
  const blur = (app, key) => app.client.evaluate(`document.querySelector(${JSON.stringify(field(key))})?.blur()`)
  const inboxSlackLine = (app) =>
    app.client.evaluate(
      `[...document.querySelectorAll(${JSON.stringify(`${INBOX} button`)})].some((b) => b.textContent.trim() === ${JSON.stringify(copy('slack.openSettings'))})`,
    )

  await withApp(context, { profile, stub }, async (app) => {
    // ── Never set up: the inbox says nothing about Slack.
    await openInboxTab(app)
    await pollFor({ read: () => app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(INBOX)}))`), settled: Boolean, timeoutMs: 10_000, label: 'the inbox' })
    const tabs = await app.client.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${INBOX} [role="tab"]`)})].map((t) => t.textContent.trim())`)
    check(results, 'the inbox has no Slack tab', tabs.length > 0 && !tabs.includes(copy('slack.label')), JSON.stringify(tabs))
    check(results, 'with Slack never set up, the inbox does not mention Slack', !(await inboxSlackLine(app)), '')

    // ── The routing hint, while no fallback is set.
    await openSlackTab(app)
    const hinted = await pollFor({ read: () => app.client.evaluate(`(${SLACK_PANEL}?.textContent ?? '')`), settled: (t) => /routing fallback/i.test(t), timeoutMs: 10_000, label: 'the routing hint' }).catch(() => '')
    check(results, 'the routing hint shows while no fallback is set', /routing fallback/i.test(hinted), hinted.slice(-200))

    // ── A token is stored only through Save or Enter, never on blur.
    await typeInto(app, 'slack.userToken', 'xoxp-typed-token')
    await blur(app, 'slack.userToken')
    await new Promise((resolve) => setTimeout(resolve, 600))
    const afterBlur = await state(app)
    check(results, 'a token is not stored when the field is left', afterBlur.configured.userToken === false, JSON.stringify(afterBlur.configured))
    await clickSelector(app.client, field('slack.userToken'), copy('slack.userToken'))
    await press(app, 'Enter', 'Enter', 13)
    const afterEnter = await pollFor({ read: () => state(app), settled: (v) => v.configured.userToken === true, timeoutMs: 10_000, label: 'the token stored' }).catch(() => afterBlur)
    check(results, 'a token is stored on Enter', afterEnter.configured.userToken === true, JSON.stringify(afterEnter.configured))

    // ── The look-back applies once: nothing while typing, the two-digit value on Enter.
    await typeInto(app, 'slack.lookback', '14')
    await new Promise((resolve) => setTimeout(resolve, 600))
    const whileTyping = (await state(app)).effective.lookbackDays
    await press(app, 'Enter', 'Enter', 13)
    const applied = await pollFor({ read: async () => (await state(app)).effective.lookbackDays, settled: (v) => v === 14, timeoutMs: 10_000, label: 'look-back 14' }).catch(() => null)
    check(
      results,
      'the look-back window applies once: nothing is stored while typing, and Enter stores the two-digit value',
      whileTyping === 7 && applied === 14,
      `while typing=${whileTyping} after Enter=${applied}`,
    )

    // ── An invalid endpoint is refused; the custom one stays.
    await typeInto(app, 'slack.endpoint', 'http://downgrade.example.test/api')
    await press(app, 'Enter', 'Enter', 13)
    const refused = await pollFor({
      read: () => app.client.evaluate(`(${SLACK_PANEL}?.textContent ?? '')`),
      settled: (t) => t.includes(copy('slack.endpointRefused')),
      timeoutMs: 10_000,
      label: 'the refusal',
    }).catch(() => '')
    const afterRefusal = await state(app)
    check(
      results,
      'an invalid endpoint is refused and the stored one stays',
      refused.includes(copy('slack.endpointRefused')) && afterRefusal.effective.apiBaseUrl === stub.baseUrl,
      `endpoint=${afterRefusal.effective.apiBaseUrl}`,
    )

    // ── An empty draft changes nothing: Esc empties it, then focus in and out.
    await clickSelector(app.client, field('slack.endpoint'), copy('slack.endpoint'))
    await press(app, 'Escape', 'Escape', 27)
    const draft = await app.client.evaluate(`document.querySelector(${JSON.stringify(field('slack.endpoint'))})?.value ?? null`)
    await blur(app, 'slack.endpoint')
    await new Promise((resolve) => setTimeout(resolve, 600))
    const afterEmpty = await state(app)
    check(
      results,
      'an empty endpoint draft changes nothing',
      draft === '' && afterEmpty.effective.apiBaseUrl === stub.baseUrl && afterEmpty.usesDefaultEndpoint === false,
      `draft=${JSON.stringify(draft)} endpoint=${afterEmpty.effective.apiBaseUrl}`,
    )

    // ── Settings has no rules editor, in any section.
    const sections = ['general', 'terminal', 'agents', 'integrations', 'remote', 'about']
    let rulesInSettings = false
    for (const section of sections) {
      await showSection(app.client, section)
      if (await app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(`${SETTINGS_DIALOG} #intake-fallback`)}))`)) rulesInSettings = true
    }
    check(results, 'Settings has no routing rules editor', rulesInSettings === false, '')
    await showSection(app.client, 'integrations')

    // ── The hint's control opens the inbox on its routing rules, with Settings closed.
    // The section mounts again on being shown: wait for its hint before pressing it.
    const HINT_BUTTON = `[...document.querySelectorAll(${JSON.stringify(`${SETTINGS_DIALOG} button`)})].find((b) => b.textContent.trim() === ${JSON.stringify(copy('slack.openRoutingRules'))})`
    await pollFor({
      read: () => app.client.evaluate(`Boolean(${HINT_BUTTON})`),
      settled: Boolean,
      timeoutMs: 10_000,
      label: "the routing hint's control",
    })
    await app.client.evaluate(`${HINT_BUTTON}?.click()`)
    const onRules = await pollFor({
      read: () =>
        app.client.evaluate(`({
          settings: Boolean(document.querySelector(${JSON.stringify(SETTINGS_DIALOG)})),
          fallback: Boolean(document.querySelector(${JSON.stringify(`${INBOX} #intake-fallback`)})),
        })`),
      settled: (v) => !v.settings && v.fallback,
      timeoutMs: 10_000,
      label: 'the inbox on routing rules',
    }).catch(() => null)
    check(
      results,
      "the routing hint's control opens the inbox on its routing rules, with Settings closed",
      onRules !== null && !onRules.settings && onRules.fallback,
      JSON.stringify(onRules),
    )

    // ── A working connection is not mentioned in the inbox.
    await pollFor({ read: () => state(app), settled: (v) => v.status.lastRoundAt !== undefined, timeoutMs: 30_000, label: 'a round ran' }).catch(() => null)
    check(results, 'with a working connection, the inbox does not mention Slack', !(await inboxSlackLine(app)), '')

    // ── A fallback set in the rules makes the hint go away.
    // The folder list loads on its own: a value set before its option exists selects nothing.
    const OPTION = `${INBOX} #intake-fallback option[value="${folderId}"]`
    await pollFor({
      read: () => app.client.evaluate(`Boolean(document.querySelector(${JSON.stringify(OPTION)}))`),
      settled: Boolean,
      timeoutMs: 10_000,
      label: 'the folder offered as fallback',
    })
    await app.client.evaluate(`(() => {
      const select = document.querySelector(${JSON.stringify(`${INBOX} #intake-fallback`)})
      select.value = ${JSON.stringify(folderId)}
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    const stored = await pollFor({
      read: () => app.client.evaluate(`window.workspace.intake.rules().then((r) => r.fallbackFolderId)`, { awaitPromise: true }),
      settled: (v) => v === folderId,
      timeoutMs: 10_000,
      label: 'the fallback stored',
    })
    check(results, 'precondition: the fallback set in the rules editor is stored', stored === folderId, String(stored))
    await openSlackTab(app)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const unhinted = await app.client.evaluate(`(${SLACK_PANEL}?.textContent ?? '')`)
    check(results, 'the routing hint goes away once a fallback is set', unhinted.length > 0 && !/routing fallback/i.test(unhinted), unhinted.slice(-200))
  })
}

/**
 * 對端要我們稍後再試。
 *
 * **可觀察面在替身端而不是收件匣。** 「不再送註定失敗的請求」不會讓畫面上多或少一張卡片
 * —— 那些請求本來就帶不回任何東西。看的是**替身收到幾次 `conversations.history`**。
 */
async function runRateLimited(_mode, context) {
  const { profile } = seedProfile()
  // **四個頻道**，而在第 2 次呼叫上被拒 —— 於是「中止」（2 次）與「跑完」（4 次）分得出來。
  const channels = [
    { id: 'C0STUBONE0', name: 'stub-one' },
    { id: 'C0STUBTWO0', name: 'stub-two' },
    { id: 'C0STUBTHR0', name: 'stub-three' },
    { id: 'C0STUBFOU0', name: 'stub-four' },
  ]
  const stub = await startStubSlack({
    port: STUB_PORT,
    state: { messages: [], channels, rateLimitOnHistoryCall: 2, retryAfterSeconds: 120 },
  })
  seedSlackSettings(profile, { baseUrl: stub.baseUrl })
  seedSlackToken(profile)
  context.stub = stub

  const historyCalls = () => stub.calls.filter((call) => call.method === 'conversations.history').length

  await withApp(context, { profile, stub }, async (app) => {
    await openSlackTab(app)
    await pollFor({
      read: () => slackText(app),
      settled: (text) => text.includes('slow down'),
      timeoutMs: 30_000,
      label: '畫面上呈現「對端要我們慢一點」',
    })

    check(
      results,
      '被要求稍後再試之後，該輪不再詢問其餘頻道',
      historyCalls() === 2,
      `conversations.history 收到 ${historyCalls()} 次（被拒的是第 2 次）`,
    )
    // **後半句是承重的**：少了它，一個「一個頻道都沒問」的實作也會讓上一條通過。
    check(
      results,
      '而那個次數確實不等於頻道總數（否則中止與跑完分不出來）',
      historyCalls() !== channels.length,
      `頻道總數 ${channels.length}，實際呼叫 ${historyCalls()} 次`,
    )

    const text = await slackText(app)
    check(
      results,
      '呈現指出這是暫時的、不需要使用者做任何事',
      /slow down/.test(text) && /Nothing is wrong/.test(text),
      text.slice(0, 200),
    )
    check(
      results,
      '該呈現與「憑證失效」及「權限不足」皆可區分',
      !text.includes('no longer valid') && !text.includes('missing permissions'),
      '沒有同時說憑證或權限有問題',
    )
  })
}

async function runNoDuplicate(_mode, context) {
  const { profile } = seedProfile()
  const mention = stubMention({ secondsAgo: 60, text: 'only once' })
  const stub = await startStubSlack({
    port: STUB_PORT,
    state: { messages: [mention], threads: { [mention.ts]: [mention] } },
  })
  seedSlackSettings(profile, { baseUrl: stub.baseUrl })
  seedSlackToken(profile)
  context.stub = stub

  const first = await launch({ profile, env: stub.env })
  context.app = first
  try {
    await openSlackTab(first)
    await openInboxTab(first)
    await awaitCard(first, 'only once')
  } finally {
    await first.close()
    context.app = null
  }

  // **水位被清掉** —— 那是會觸發重新推導的主要原因（重裝、設定還原、損毀隔離）。
  try {
    unlinkSync(join(profile, 'slack-cursors.json'))
  } catch {
    // 沒有水位檔也算「水位遺失」。
  }
  // 頻道與發話者都改名 ⇒ 內容會不同，於是「只比對內容」的實作會跳假警示。
  stub.calls.length = 0
  stub.state.names = { U0STUBMATE: 'renamed-mate' }

  const second = await launch({ profile, env: stub.env, port: RESTART_PORT })
  context.app = second
  try {
    await openSlackTab(second)
    await pollFor({
      read: () => stub.calls.filter((e) => e.method === 'conversations.history').length,
      settled: (count) => count > 0,
      timeoutMs: 30_000,
      label: '第二輪重新取回',
    })
    await openInboxTab(second)
    await awaitCard(second, 'only once')

    const cards = await inboxText(second)
    const count = await cardCount(second, 'only once')
    check(results, '水位遺失之後不重複交付（卡片仍為一張）', count === 1, `卡片 ${count} 張`)
    const overlay = await overlayText(second)
    check(
      results,
      '不產生面向使用者的拒絕或警示（含收件匣的拒絕彙整）',
      !/rejected/i.test(overlay),
      overlay.slice(0, 300),
    )
    // **這條是必要的**：少了它，「那則根本沒被重新看見」會讓上面兩條假綠。
    check(
      results,
      '該提及確實被重新取回並考慮過',
      stub.calls.some((e) => e.method === 'conversations.history'),
      `第二輪的呼叫：${[...new Set(stub.calls.map((c) => c.method))].join(', ')}`,
    )
  } finally {
    await second.close()
    context.app = null
    await stub.close()
    context.stub = null
  }
}

async function runTruncation(_mode, context) {
  const { profile } = seedProfile()
  const mention = stubMention({ secondsAgo: 60, text: `${'T'.repeat(400)} needs review` })
  const bulk = Array.from({ length: 40 }, (_, index) =>
    stubMessage({ secondsAgo: 300 - index, text: 'Y'.repeat(200) }),
  )
  const stub = await startStubSlack({
    port: STUB_PORT,
    state: { messages: [mention], threads: { [mention.ts]: [...bulk, mention] } },
  })
  seedSlackSettings(profile, { baseUrl: stub.baseUrl })
  seedSlackToken(profile)
  context.stub = stub

  await withApp(context, { profile, stub }, async (app) => {
    await openSlackTab(app)
    await openInboxTab(app)
    await awaitCard(app, 'needs review')

    const cards = await inboxText(app)
    check(results, '過長的討論串與標題都不使整則被拒絕', cards.includes('needs review'), cards.slice(0, 160))
    check(results, '截斷的說明出現在本文之內', /left out/.test(cards), cards.slice(0, 400))
    check(results, '沒有面向使用者的拒絕', !/reject/i.test(cards), cards.slice(0, 160))
  })
}

async function runLookback(_mode, context) {
  const { profile } = seedProfile()
  const inside = stubMention({ secondsAgo: 60, text: 'INSIDE-WINDOW' })
  const outside = stubMention({ secondsAgo: 3 * 24 * 60 * 60, text: 'OUTSIDE-WINDOW' })
  const stub = await startStubSlack({
    port: STUB_PORT,
    state: {
      messages: [outside, inside],
      threads: { [inside.ts]: [inside], [outside.ts]: [outside] },
    },
  })
  // 回看範圍 1 天 ⇒ 三天前那一則落在範圍之外。
  seedSlackSettings(profile, { baseUrl: stub.baseUrl, lookbackDays: 1 })
  seedSlackToken(profile)
  context.stub = stub

  await withApp(context, { profile, stub }, async (app) => {
    await openSlackTab(app)
    await openInboxTab(app)
    await awaitCard(app, 'INSIDE-WINDOW')

    const cards = await inboxText(app)
    // **兩則必須同時存在** —— 只驗範圍之外那一則時，「回補整個沒有運作」會讓它全綠。
    check(results, '回看範圍之內的提及出現', cards.includes('INSIDE-WINDOW'), cards.slice(0, 160))
    check(results, '回看範圍之外的提及不出現', !cards.includes('OUTSIDE-WINDOW'), cards.slice(0, 160))

    await openSlackTab(app)
    const text = await slackText(app)
    check(results, '目前的回看範圍對使用者可見', /1 day/.test(text), text.slice(0, 240))
  })
}

async function runEndpointVisible(_mode, context) {
  const { profile } = seedProfile()
  const stub = await startStubSlack({ port: STUB_PORT, state: { messages: [] } })
  seedSlackSettings(profile, { baseUrl: stub.baseUrl })
  seedSlackToken(profile)
  context.stub = stub

  await withApp(context, { profile, stub }, async (app) => {
    await openSlackTab(app)
    const text = await slackText(app)
  // **一個沉默的端點欄位比沒有這個欄位更糟** —— 憑證的目的地是一個資料欄位（使用者的裁決）。
    check(results, '端點非預設值時畫面上明確警示', /Custom endpoint in use/.test(text), text.slice(0, 300))
    // With a fallback set, the routing hint stays away (`slack-intake-source`); `runSettingsFields` has the other half.
    check(results, 'the routing hint is absent while a fallback is set', !/routing fallback/i.test(text), text.slice(0, 500))
    // 替身回一個連不上的 wss ⇒ 即時路徑不得謊報為已連線。
    check(results, '即時路徑未謊報為已連線', !/On — new mentions arrive/.test(text), text.slice(0, 300))

    // **斷言整份 IPC 回傳值**，不是 DOM —— 憑證可以在 payload 裡而畫面上不顯示。
    const payload = await app.client.evaluate(
      `window.workspace.slack.get().then((state) => JSON.stringify(state))`,
      { awaitPromise: true },
    )
    const serialized = String(payload)
    check(results, 'IPC 回傳值整份不含憑證', !serialized.includes('xoxp-'), serialized.slice(0, 200))
    check(
      results,
      '但它確實回報「已設定」（否則上一條對空回傳值也成立）',
      serialized.includes('"userToken":true'),
      serialized.slice(0, 200),
    )
  })
}

const SECTIONS = [
  { name: 'runDelivery', run: runDelivery },
  { name: 'runPersistedLanguage', run: runPersistedLanguage },
  { name: 'runAuthFailure', run: runAuthFailure },
  { name: 'runRateLimited', run: runRateLimited },
  { name: 'runNoDuplicate', run: runNoDuplicate, deps: ['runDelivery'] },
  { name: 'runTruncation', run: runTruncation },
  { name: 'runLookback', run: runLookback },
  { name: 'runEndpointVisible', run: runEndpointVisible },
  { name: 'runSettingsFields', run: runSettingsFields },
]

const outcome = await runSections({
  sections: SECTIONS,
  build: { port: PORT, rendererUrl: null },
  dev: null,
  results,
  afterMode: async (_mode, context) => {
    if (context.app) await context.app.close()
    if (context.stub) await context.stub.close()
  },
  cleanup: () => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true })
  },
})

process.exit(outcome ? 0 : 1)
