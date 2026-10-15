/**
 * 驗證 `agent-transcript-view` 的四個能力：`agent-transcript-stream`、`agent-event-bridge`、
 * `agent-conversation-view`、`agent-input-bridge`。
 *
 * ## 替身 agent，而不是真的 agent
 *
 * 真實委派刻意不進探針（要網路、會花錢、回覆不可重現）—— 與 `conversation-report` 同一條理由。
 * 這裡的替身做三件真事：**照著我們注入的 `--settings` 真的呼叫 hook 命令**、**真的把紀錄寫到
 * 我們算得出來的位置**、**真的回報它拿到的終端尺寸**。
 *
 * 只斷言「argv 裡有 `--settings`」證明不了任何事：注入的命令能不能跑、落點對不對、環境變數有沒有
 * 到，全都在那之外。**而那正是本 change 實際踩到的失敗** —— hook 命令有一個多餘的分號，
 * shell 語法錯，於是每一次都失敗，而事件目錄只是安靜地空著。
 *
 * 「真的 agent 會呼叫我們注入的東西」不在這裡，由 dogfood 認定 —— 該缺口寫在規格裡。
 *
 * ## 終端尺寸那一段是本支最容易假綠的一條
 *
 * 對話 view 在上層時終端仍必須保有版面盒子，否則 pty 會停在一個從未被量測過的初始值
 * （80×24），agent 以錯誤的寬度輸出，**而那些輸出一旦印出就永久留在終端歷史裡**。
 * **不修也不會紅**：agent 照樣回話，症狀要到使用者切去終端 view 看歷史時才顯現。
 * 因此那一段以替身回報的 `stty size` 為觀察對象，並在同一輪驗一次對照組。
 *
 * 用法：npm run probe:agent-view
 */
import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
    mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, connectToApp, pollFor, pressKey } from './lib/cdp.mjs'
import { copy, label } from './lib/copy.mjs'
import { makeStubAgent } from './lib/stub-agent.mjs'
import { awaitMounted } from './lib/mounted.mjs'
import { electronExtraArgs } from './lib/display.mjs'
import { runSections } from './lib/sections.mjs'
import { PROBE_PORTS } from './lib/ports.mjs'
import { RENDER_PATH_PRELUDE } from './lib/render-path.mjs'
import { seedLanguage } from './lib/probe-language.mjs'

const PORT = PROBE_PORTS.agentView.main
const RESTORE_PORT = PROBE_PORTS.agentView.restore

const results = []
const temps = []

function mkTemp(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temps.push(dir)
  return dir
}


function seedProfile(repo) {
  const profile = mkTemp('spekterm-agentview-profile-')
  writeFileSync(
    join(profile, 'workspace.json'),
    JSON.stringify({
      version: 1,
      folders: [{ id: 'f1', path: repo, addedAt: '2026-09-06T00:00:00.000Z' }],
    }),
  )
  return profile
}

async function launch({ profile, configDir, stub, port = PORT }) {
  // 被測 app 的語言是**被指定的**：全新的 profile 會觸發首次啟動的語言偵測，
  // 而在一台非英文的機器上，那會讓每一條 `aria-label` 選擇器選不到元素。
  // 既有的 `preferences.json` 不動（損毀韌性與舊檔那兩段自己佈置它）。
  seedLanguage(profile)

  const child = spawn(
    'electron',
    [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...electronExtraArgs(), '.'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SHELL: '/bin/sh',
        CLAUDE_CONFIG_DIR: configDir,
        // agent 目標走 `$SHELL -l -c claude`，**而 login shell 會重設 PATH** —— 只前置 bin
        // 是不夠的，`~/.profile` 會把真的 claude 搶回前面。因此 HOME 也要換掉。
        // （`probe-terminal` 的同一段註解記著這件事；漏掉它的徵狀是「替身完全沒被執行」，
        // 而畫面上一切正常 —— 產品那邊的斷言才是紅的。）
        HOME: stub.home,
        PATH: `${stub.bin}:${process.env.PATH}`,
      },
    },
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
      // 落盤是 debounce 的；給它一點時間把 session 清單寫出去。
      await new Promise((resolve) => setTimeout(resolve, 900))
    },
  }
}

// ── 讀畫面的表達式 ──────────────────────────────────────────────────────────

/**
 * rail 的列以**專案名稱**為 `aria-label`（那是這個 repo 的慣例，見 `WorkspaceRail`）——
 * 因此選擇器要在執行期以 fixture 的目錄名組出來，不能寫死。
 */
function selectRepoExpression(name) {
  return `(() => {
    const row = document.querySelector('[aria-label="${name}"]')
    if (!row) return false
    row.click()
    return true
  })()`
}

const CREATE_SESSION = `(() => {
  const button = document.querySelector('${label('sessions.new')}')
  if (!button) return 'no-button'
  button.click()
  return 'clicked'
})()`

const VIEW_STATE = `(() => {
  const toggle = document.querySelector('${label('conversation.showConversation')}')
    ?? document.querySelector('${label('conversation.showTerminal')}')
  const composer = document.querySelector('${label('conversation.composer')}')
  const send = document.querySelector('${label('conversation.send')}')
  return {
    hasToggle: Boolean(toggle),
    toggleLabel: toggle?.getAttribute('aria-label') ?? null,
    hasComposer: Boolean(composer),
    sendDisabled: send ? send.disabled : null,
    text: document.querySelector('[aria-label="${copy('stage.terminal')}"]')?.innerText ?? '',
  }
})()`

const TOGGLE_VIEW = `(() => {
  const toggle = document.querySelector('${label('conversation.showConversation')}')
    ?? document.querySelector('${label('conversation.showTerminal')}')
  if (!toggle) return false
  toggle.click()
  return true
})()`

// ── 段落 ────────────────────────────────────────────────────────────────────

const COMPOSER = `document.querySelector('${label('conversation.composer')}')`

/** A visible Wake button inside the terminal stage (session-hibernation). */
const WAKE_IN_STAGE = `[...(document.querySelector('[aria-label="${copy('stage.terminal')}"]')?.querySelectorAll('button') ?? [])].some((b) => b.textContent === ${JSON.stringify(copy('sessions.wake'))} && b.getBoundingClientRect().width > 0)`

/** Whether focus sits on a Wake button. */
const CONVERSATION_WAKE_FOCUSED = `(document.activeElement?.tagName === 'BUTTON' && document.activeElement.textContent === ${JSON.stringify(copy('sessions.wake'))})`

/** Whether any process of the stub agent for this conversation is still running. */
function agentAlive(conversationId) {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes(conversationId)) return true
    } catch {
      // the process ended while being read
    }
  }
  return false
}
const SEND = `document.querySelector('${label('conversation.send')}')`

/** 預設是終端 view；切到對話 view 後內容抵達，且送得出去。 */
async function runViewAndSend(_mode, _config, context) {
  const repo = mkTemp('spekterm-agentview-repo-')
  const configDir = mkTemp('spekterm-agentview-config-')
  const stub = makeStubAgent(mkTemp, configDir)
  const profile = seedProfile(repo)
  Object.assign(context, { profile, configDir, stub, repo, repoName: repo.split('/').pop() })

  const app = await launch({ profile, configDir, stub })
  context.app = app

  await pollFor({
    read: () => app.client.evaluate(selectRepoExpression(context.repoName)),
    settled: (ok) => ok === true,
    timeoutMs: 15_000,
    label: '選中 repo',
  })
  await pollFor({
    read: () => app.client.evaluate(CREATE_SESSION),
    settled: (r) => r === 'clicked',
    timeoutMs: 15_000,
    label: '建立 session 的入口可點',
  })
  await pollFor({
    read: () =>
      app.client.evaluate(`(() => {
        const item = [...document.querySelectorAll('[role="menuitem"]')]
          .find((el) => el.textContent.trim().toLowerCase().includes('claude'))
        if (!item) return false
        item.click()
        return true
      })()`),
    settled: (ok) => ok === true,
    timeoutMs: 15_000,
    label: 'spawn 選單出現且可選 agent',
  })

  const initial = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.hasToggle,
    timeoutMs: 25_000,
    label: 'agent session 建立後出現切換入口',
  })
  check(
    results,
    'agent session 預設為終端 view，且提供切換入口',
    initial.toggleLabel === copy('conversation.showConversation') && !initial.hasComposer,
    `切換入口＝${initial.toggleLabel}，對話輸入框存在＝${initial.hasComposer}`,
  )

  await app.client.evaluate(TOGGLE_VIEW)
  const conversation = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.hasComposer,
    timeoutMs: 15_000,
    label: '切換到對話 view',
  })
  check(results, '對話 view 呈現輸入框', conversation.hasComposer, '輸入框存在')

  const withContent = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.text.includes('STUB-HELLO-'),
    timeoutMs: 25_000,
    label: 'agent 寫下的內容抵達對話 view',
  })
  check(
    results,
    '紀錄中的內容抵達對話 view',
    withContent.text.includes('STUB-HELLO-'),
    'agent 寫下的訊息已呈現',
  )

  // 送出按鈕在草稿為空時本來就是停用的 —— 先填草稿，才問得出「等待狀態允不允許」。
  await app.client.evaluate(`(() => {
    const box = ${COMPOSER}
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(box, 'PROBE-SENT')
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  const sendable = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.sendDisabled === false,
    timeoutMs: 25_000,
    label: '等待狀態由替身的事件推到可送出',
  })
  check(
    results,
    '替身觸發的事件使等待狀態變為可送出（注入的 hook 命令真的被執行）',
    sendable.sendDisabled === false,
    '送出按鈕已啟用',
  )

  await app.client.evaluate(`${SEND}.click()`)
  const arrived = await pollFor({
    read: () => stub.input(),
    settled: (text) => text.includes('PROBE-SENT'),
    timeoutMs: 15_000,
    label: '送出的內容抵達 pty',
  })
  check(results, '對話 view 送出的內容抵達 pty', arrived.includes('PROBE-SENT'), '替身收到 PROBE-SENT')

  // 切回終端 view —— 逃生口必須一直在。
  await app.client.evaluate(TOGGLE_VIEW)
  const back = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => !state.hasComposer,
    timeoutMs: 15_000,
    label: '切回終端 view',
  })
  check(
    results,
    '切回終端 view 後對話輸入框消失，切換入口仍在',
    !back.hasComposer && back.hasToggle,
    `輸入框＝${back.hasComposer}，切換入口＝${back.hasToggle}`,
  )

  // 讓下一段以「對話 view」為當前 view 重建。
  await app.client.evaluate(TOGGLE_VIEW)
  await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.hasComposer,
    timeoutMs: 15_000,
    label: '回到對話 view（供重建段使用）',
  })

  /*
    **等它真的落盤，不要猜。**

    此前這裡直接進下一段，於是重建段永遠看到終端 view，而**寬度那條斷言照樣是綠的**
    （終端 view 之下終端本來就掛載得好好的）—— 一盞完美的假綠：它通過了，但它證明的不是
    它自稱在證明的事。

    **等待的理由換過了。** 選擇改為全域偏好之後落點是 `preferences.json`，而偏好的寫入
    **沒有 debounce**（每個 setter 直接原子寫檔）—— 剩下的只有一次 IPC 往返。
    連帶：此前這次等待隱含保證的「`sessions.json` 已 flush」**不再成立**
    （那一份仍是 500ms debounce），下面對它的斷言因此自己帶前置。

    讀落盤結果同時也是「view 的選擇跨重啟保留」這條 requirement 的載體。
  */
  const readJson = (name) => {
    try {
      return JSON.parse(readFileSync(join(context.profile, name), 'utf8'))
    } catch {
      return null
    }
  }
  const prefs = await pollFor({
    read: () => readJson('preferences.json'),
    settled: (data) => data?.terminal?.agentView === 'conversation',
    timeoutMs: 15_000,
    label: 'view 的選擇落盤於偏好檔',
  })
  check(
    results,
    'view 的選擇被持久化於偏好檔',
    prefs.terminal.agentView === 'conversation',
    `偏好檔的 terminal：${JSON.stringify(prefs.terminal)}`,
  )

  /*
    **反向：它不得同時落在 session 的持久化紀錄裡。**

    只驗「偏好檔裡有」的話，一個「兩邊都寫」的實作照樣全綠 —— 而那正是這個 change 要消滅的
    狀態（兩處都寫使「兩個 session 的 view 不一樣」重新變得表達得出來）。

    **否定式斷言要自帶前置。** 檔案讀不到（回 `null`）或 `sessions` 是空陣列時，
    `every(...)` 恆真 —— 那是 `probes.md` 記過的同一型假綠。
  */
  const sessionsFile = await pollFor({
    read: () => readJson('sessions.json'),
    settled: (data) => Array.isArray(data?.sessions) && data.sessions.length >= 1,
    timeoutMs: 15_000,
    label: 'sessions.json 已落盤且非空（否定式斷言的前置）',
  })
  check(
    results,
    '前置：落盤的 session 就是這一段建立的那個 agent session',
    sessionsFile.sessions.some((entry) => entry.spawnTarget === 'claude'),
    `落盤的 spawnTarget：${sessionsFile.sessions.map((entry) => entry.spawnTarget).join(', ')}`,
  )
  check(
    results,
    'view 的選擇 SHALL NOT 落在 session 的持久化紀錄裡',
    sessionsFile.sessions.every((entry) => !('view' in entry)),
    `落盤的 session 欄位：${sessionsFile.sessions.map((entry) => Object.keys(entry).join('+')).join(' / ')}`,
  )
}

/**
 * **本支最容易假綠的一段。**
 *
 * 重建後直接以對話 view 喚醒的 session，其 pty 的欄數必須與可用寬度相符 —— 而不是那個從未被
 * 量測過的初始值。不修**也不會紅**：agent 照樣回話，症狀要到使用者切去終端 view 看歷史才顯現。
 *
 * **一個沒有載體的時序前提**（`global-conversation-view-preference` 之後新增）：
 * view 的選擇改為全域偏好之後，它與 `restore()` 是**兩條互不相干的非同步**，先後沒有保證。
 * 偏好晚到的那個窗口裡，終端會先以**未覆蓋**狀態出現並被 fit 一次 —— 欄數在那一瞬間就已經
 * 正確，於是這一段即使在「對話 view 在上層時終端沒有版面盒子」的錯誤實作下也可能通過。
 *
 * **刻意不為它做載體**：那是一個競賽窗口，抽樣式的觀察做不出穩定的判別，而一條時綠時紅、
 * 且證明不了什麼的斷言比沒有更糟（見 `docs/lessons/probes.md`）。此前沒有這個窗口 ——
 * `session.view` 與 session 本身來自同一次 `restore()`，是原子的。
 */
async function runRebuiltWidth(_mode, _config, context) {
  await context.app.close()
  context.app = null

  const stub = makeStubAgent(mkTemp, context.configDir)
  const app = await launch({
    profile: context.profile,
    configDir: context.configDir,
    stub,
    port: RESTORE_PORT,
  })
  context.app = app

  await pollFor({
    read: () => app.client.evaluate(selectRepoExpression(context.repoName)),
    settled: (ok) => ok === true,
    timeoutMs: 15_000,
        label: '重建後選中 repo',
  })
  // Displaying a dormant session no longer starts it (session-persistence): the conversation view
  // offers Wake, with focus on it, and Enter wakes the session — no click.
  const wakeFocused = await pollFor({
    read: () => app.client.evaluate(CONVERSATION_WAKE_FOCUSED),
    settled: (focused) => focused === true,
    timeoutMs: 15_000,
    label: 'the dormant conversation view focuses its Wake button',
  })
  check(
    results,
    'a dormant session in the conversation view offers Wake, with focus on it',
    wakeFocused === true,
    `activeElement=${JSON.stringify(await app.client.evaluate('document.activeElement?.outerHTML?.slice(0, 120) ?? null'))}`,
  )
  await pressKey(app.client, 'Enter')
  const state = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (view) => view.hasComposer,
    timeoutMs: 25_000,
    label: '重建的 session 以對話 view 呈現（view 的選擇跨重啟保留）',
  })
  check(
    results,
    '重建後回到上次的 view（對話）',
    state.hasComposer,
    `輸入框＝${state.hasComposer}，切換入口＝${state.toggleLabel}，畫面＝${JSON.stringify(state.text.slice(0, 120))}`,
  )

  const cols = await pollFor({
    read: () => {
      try {
        return stub.cols()
      } catch {
        return 0
      }
    },
    // **等它最終不再是暫定值。** 沒有版面盒子的話校正永遠不會來，這個等待就會耗盡 —— 那正是
    // 這條 requirement 的失效樣貌，而不是一個時序上的巧合。
    settled: (value) => value > 0 && value !== 80,
    timeoutMs: 25_000,
    label: '替身回報的終端尺寸最終不再是 spawn 當下的暫定值',
  })
  check(
    results,
    '對話 view 在上層時 pty 的欄數與可用寬度相符（不是未經量測的初始值）',
    cols !== 80 && cols > 0,
    `替身回報 cols=${cols}（初始暫定值為 80）`,
  )
}


/**
 * **內容與輸入是兩條獨立的路。**
 *
 * 替身這次完全不觸發事件（模擬「事件橋接未注入／注入失敗」）。等待狀態恆為未知 ⇒ 送不出去，
 * **但內容照樣讀得到**。這是 design 最重要的降級路徑：少了 hooks，使用者失去的是「在新畫面
 * 打字」，不是「看不到內容」。
 *
 * 同時驗「未知時拒絕並說明原因」—— 一個永遠灰掉又不說原因的輸入框，與「壞掉」在畫面上分不出來
 * （dogfood 第一次就撞上了）。
 */
async function runReadableWithoutEvents(_mode, _config, context) {
  if (context.app) await context.app.close()
  const repo = mkTemp('spekterm-agentview-repo2-')
  const configDir = mkTemp('spekterm-agentview-config2-')
  const stub = makeStubAgent(mkTemp, configDir, { honorHooks: false })
  const profile = seedProfile(repo)
  const repoName = repo.split('/').pop()

  const app = await launch({ profile, configDir, stub, port: PORT })
  context.app = app

  await pollFor({
    read: () => app.client.evaluate(selectRepoExpression(repoName)),
    settled: (ok) => ok === true,
    timeoutMs: 15_000,
    label: '選中 repo',
  })
  await pollFor({
    read: () => app.client.evaluate(CREATE_SESSION),
    settled: (r) => r === 'clicked',
    timeoutMs: 15_000,
    label: '建立 session 的入口可點',
  })
  await pollFor({
    read: () =>
      app.client.evaluate(`(() => {
        const item = [...document.querySelectorAll('[role="menuitem"]')]
          .find((el) => el.textContent.trim().toLowerCase().includes('claude'))
        if (!item) return false
        item.click()
        return true
      })()`),
    settled: (ok) => ok === true,
    timeoutMs: 15_000,
    label: 'spawn 選單可選 agent',
  })
  await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.hasToggle,
    timeoutMs: 25_000,
    label: '切換入口出現',
  })
  await app.client.evaluate(TOGGLE_VIEW)

  const state = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (view) => view.hasComposer && view.text.includes('STUB-HELLO-'),
    timeoutMs: 25_000,
    label: '未注入事件時，對話 view 仍讀得到內容',
  })
  check(
    results,
    '未注入事件回報時對話 view 仍可讀（內容與輸入是兩條獨立的路）',
    state.text.includes('STUB-HELLO-'),
    'agent 寫下的訊息已呈現',
  )

  // 填草稿 —— 送出按鈕在草稿為空時本來就是停用的，不填就問不出「等待狀態允不允許」。
  await app.client.evaluate(`(() => {
    const box = document.querySelector('${label('conversation.composer')}')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(box, 'SHOULD-NOT-ARRIVE')
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  const blocked = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (view) => view.sendDisabled === true,
    timeoutMs: 10_000,
    label: '等待狀態未知 ⇒ 送出停用',
  })
  check(results, '等待狀態未知時送出停用', blocked.sendDisabled === true, '送出按鈕為停用')
  check(
    results,
    '停用時說明原因（不是一個沉默的灰按鈕）',
    blocked.text.includes(copy('conversation.waitingForState').slice(0, 24)),
    `畫面上出現說明＝${blocked.text.includes(copy('conversation.waitingForState').slice(0, 24))}`,
  )

  /*
    主行程才是閘 —— 繞過 UI 直接呼叫 IPC 也必須被拒絕。

    **用真正的 session id，不是一個隨便的字串。** 一個不匹配的 id 本來就會被拒（它連不到任何
    訂閱），於是那樣的斷言證明的是「錯的 id 會被拒」，而不是「未知狀態會被拒」——
    兩者是不同的事，而前者對這條 requirement 沒有任何鑑別力。
  */
  const sessionId = await pollFor({
    read: () => {
      try {
        const data = JSON.parse(readFileSync(join(profile, 'sessions.json'), 'utf8'))
        return data.sessions?.[0]?.id ?? null
      } catch {
        return null
      }
    },
    settled: (id) => typeof id === 'string',
    timeoutMs: 15_000,
    label: '取得真正的 session id',
  })
  const refused = await app.client.evaluate(`(async () => {
    const result = await window.workspace.conversation.send(${JSON.stringify(sessionId)}, 'SHOULD-NOT-ARRIVE')
    return { ok: result.ok, reason: result.reason ?? null }
  })()`)
  check(
    results,
    '送出的閘在主行程 —— 以**真正的** session id 繞過 UI 仍被拒絕',
    refused.ok === false && refused.reason === 'unknown',
    `主行程回覆 ok=${refused.ok} reason=${refused.reason}（session=${sessionId.slice(0, 8)}）`,
  )
  check(
    results,
    '被拒絕的內容沒有抵達 pty',
    !stub.input().includes('SHOULD-NOT-ARRIVE'),
    `替身收到的輸入：${JSON.stringify(stub.input().slice(0, 60))}`,
  )
}


/** 建立一個 agent session（選中 repo → 建立入口 → spawn 選單選 agent）。 */
async function createAgentSession(app, repoName) {
  await pollFor({
    read: () => app.client.evaluate(selectRepoExpression(repoName)),
    settled: (ok) => ok === true,
    timeoutMs: 15_000,
    label: '選中 repo',
  })
  await pollFor({
    read: () => app.client.evaluate(CREATE_SESSION),
    settled: (r) => r === 'clicked',
    timeoutMs: 15_000,
    label: '建立 session 的入口可點',
  })
  await pollFor({
    read: () =>
      app.client.evaluate(`(() => {
        const item = [...document.querySelectorAll('[role="menuitem"]')]
          .find((el) => el.textContent.trim().toLowerCase().includes('claude'))
        if (!item) return false
        item.click()
        return true
      })()`),
    settled: (ok) => ok === true,
    timeoutMs: 15_000,
    label: 'spawn 選單可選 agent',
  })
}

/**
 * session 分頁列上的第 n 個分頁（0 起）。
 *
 * **一定要連 `aria-label` 一起指名 tablist。** 這個 app 有四到五個 `role="tablist"`
 * （身分切換、OpenSpec 視圖、artifact 分頁、session 分頁），
 * `querySelectorAll('[role="tab"]')[0]` 抓到的**不是** session 分頁 ——
 * 實測踩到：點下去焦點根本沒動，而斷言報的是「切換後看到的是另一個 session 的內容」，
 * 看起來像產品把 A 的對話畫在 B 的畫面上。
 */
function focusTabExpression(index) {
  return `(() => {
    const list = document.querySelector('[role="tablist"][aria-label="${copy('sessions.tabs')}"]')
    if (!list) return false
    const tabs = [...list.querySelectorAll('[role="tab"]')]
    if (!tabs[${index}]) return false
    tabs[${index}].click()
    return true
  })()`
}

/**
 * 兩個並行的 agent session **各自跟進自己的紀錄**，而 **view 的選擇是全域的、兩者共用**。
 *
 * 定位若以「最近被修改的紀錄」之類的搜尋實作，這裡就會**把 A 的對話呈現在 B 的畫面上** ——
 * 而那比沒有內容更糟，因為它看起來完全正常。
 *
 * **view 那一半此前驗的是相反的事**（per-session）。全域化之後這裡承擔兩條 requirement：
 * 新建的 session 採用當前的全域選擇、以及切換其中一個時另一個一起改變。
 */
async function runParallelSessions(_mode, _config, context) {
  if (context.app) await context.app.close()
  const repo = mkTemp('spekterm-agentview-repo3-')
  const configDir = mkTemp('spekterm-agentview-config3-')
  const stub = makeStubAgent(mkTemp, configDir)
  const profile = seedProfile(repo)
  const repoName = repo.split('/').pop()
  const app = await launch({ profile, configDir, stub, port: PORT })
  context.app = app

  await createAgentSession(app, repoName)
  await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.hasToggle,
    timeoutMs: 25_000,
    label: '第一個 session 建立',
  })
  await app.client.evaluate(TOGGLE_VIEW)
  const first = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.hasComposer && /STUB-HELLO-[0-9a-f-]{36}/.test(state.text),
    timeoutMs: 25_000,
    label: '第一個 session 的內容抵達',
  })
  const firstMarker = /STUB-HELLO-([0-9a-f-]{36})/.exec(first.text)[1]

  /*
    **新建的 session 採用當前的全域選擇。** 第一個已經在對話 view，所以第二個一建立就該是。

    **不可以 `hasComposer` 當 settled 條件。** `VIEW_STATE` 是 document-wide，而 DOM 裡只有
    focused session 的那一份；`createAgentSession` 點完 spawn 選單就回來，此刻**第一個
    session 的輸入框還在畫面上** ⇒ `hasComposer` 立刻為真 ⇒ **產品若維持 per-session，
    這條照樣綠**。因此錨在**身分**上：等分頁數變成 2，且畫面上的 marker 換成了另一個。
  */
  await createAgentSession(app, repoName)
  const secondConv = await pollFor({
    read: () =>
      app.client.evaluate(`(() => {
        const state = ${VIEW_STATE}
        const list = document.querySelector('[role="tablist"][aria-label="${copy('sessions.tabs')}"]')
        return { ...state, tabs: list ? list.querySelectorAll('[role="tab"]').length : 0 }
      })()`),
    settled: (state) =>
      state.tabs === 2 &&
      /STUB-HELLO-[0-9a-f-]{36}/.test(state.text) &&
      !state.text.includes(firstMarker),
    timeoutMs: 25_000,
    label: '第二個 session 建立且其內容抵達（分頁數＝2 且 marker 已換人）',
  })
  const secondMarker = /STUB-HELLO-([0-9a-f-]{36})/.exec(secondConv.text)[1]
  check(
    results,
    '新建的第二個 session 採用當前的全域選擇（對話 view）',
    secondConv.hasComposer && secondConv.toggleLabel === copy('conversation.showTerminal'),
    `輸入框＝${secondConv.hasComposer}，切換入口＝${secondConv.toggleLabel}`,
  )

  check(
    results,
    '兩個並行的 session 各自跟進自己的紀錄（不會把 A 的對話畫在 B 的畫面上）',
    firstMarker !== secondMarker && !secondConv.text.includes(firstMarker),
    `第一個＝${firstMarker.slice(0, 8)}，第二個＝${secondMarker.slice(0, 8)}，第二個畫面含第一個的內容＝${secondConv.text.includes(firstMarker)}`,
  )

  // 切回第一個 —— 它的 view 與內容都該是自己的。
  await pollFor({
    read: () => app.client.evaluate(focusTabExpression(0)),
    settled: (ok) => ok === true,
    timeoutMs: 10_000,
    label: '切回第一個 session',
  })
  const backToFirst = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.text.includes(firstMarker),
    timeoutMs: 20_000,
    label: '第一個 session 的內容回來',
  })
  check(
    results,
    '切換 session 後內容跟著它自己（view 則是共用的，見下）',
    backToFirst.text.includes(firstMarker) && !backToFirst.text.includes(secondMarker),
    `含自己的內容＝${backToFirst.text.includes(firstMarker)}，含另一個的＝${backToFirst.text.includes(secondMarker)}`,
  )

  /*
    **切回終端時其他 session 亦回到終端。**

    **方向不可反。** 兩個都已在對話 view 時，「把其中一個切到對話、另一個也是對話」與
    「它一直都是對話」在觀察上完全相同 —— 往終端方向的那一次才具鑑別力。

    而「另一個也變了」**必須切回去才看得到**（`VIEW_STATE` 只讀得到 focused 的那一份）。
  */
  await pollFor({
    read: () => app.client.evaluate(focusTabExpression(1)),
    settled: (ok) => ok === true,
    timeoutMs: 10_000,
    label: '切到第二個 session（準備把它切回終端）',
  })
  await app.client.evaluate(TOGGLE_VIEW)
  await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => !state.hasComposer,
    timeoutMs: 15_000,
    label: '第二個 session 切回終端 view',
  })
  await pollFor({
    read: () => app.client.evaluate(focusTabExpression(0)),
    settled: (ok) => ok === true,
    timeoutMs: 10_000,
    label: '切回第一個 session（觀察它是否也變了）',
  })
  const firstAfter = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.hasToggle,
    timeoutMs: 15_000,
    label: '第一個 session 的呈現就緒',
  })
  check(
    results,
    '切回終端時其他 session 亦回到終端（view 的選擇是全域的）',
    !firstAfter.hasComposer && firstAfter.toggleLabel === copy('conversation.showConversation'),
    `輸入框＝${firstAfter.hasComposer}，切換入口＝${firstAfter.toggleLabel}`,
  )

  /*
    **把全域偏好還原為對話 view —— 下一段依賴它。**

    `runDormantConversation` 重啟後期待畫面出現休眠的**對話**呈現，而決定那件事的現在是
    profile-wide 的偏好（此前是那個 session 自己的欄位）。不還原的話它會紅，而訊息看起來
    像「休眠的呈現壞了」，離根因隔了兩層。
  */
  await app.client.evaluate(TOGGLE_VIEW)
  await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.hasComposer,
    timeoutMs: 15_000,
    label: '還原為對話 view（供休眠段使用）',
  })

  context.parallel = { profile, configDir, repo, repoName }
}

/**
 * **休眠的 session 於對話 view 呈現休眠，不是一份空的對話。**
 *
 * 一份空的對話與「這個 session 真的還沒講話」無法區分，而兩者的正確處置不同。
 *
 * fixture：把 repo 目錄移走再重建 —— 喚醒會失敗，session 因此**停在**休眠態（比照
 * `probe-terminal` 造 `wakeError` 的作法）。這是唯一穩定觀察得到休眠的方式：正常路徑上，
 * 一個 session 被顯示的那一刻就醒了。
 */
async function runDormantConversation(_mode, _config, context) {
  await context.app.close()
  context.app = null
  const { profile, configDir, repo, repoName } = context.parallel
  rmSync(repo, { recursive: true, force: true })

  const stub = makeStubAgent(mkTemp, configDir)
  const app = await launch({ profile, configDir, stub, port: RESTORE_PORT })
  context.app = app

  await pollFor({
    read: () => app.client.evaluate(selectRepoExpression(repoName)),
    settled: (ok) => ok === true,
    timeoutMs: 15_000,
    label: '選中已消失的 repo',
  })
  const state = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (view) => view.text.includes(copy('conversation.dormant').slice(0, 20)),
    timeoutMs: 25_000,
    label: '休眠 session 於對話 view 呈現休眠狀態',
  })
    check(
    results,
    '休眠的 session 於對話 view 呈現休眠，而非一份空的對話',
    state.text.includes(copy('conversation.dormant').slice(0, 20)),
    `畫面＝${JSON.stringify(state.text.slice(0, 80))}`,
  )
  check(
    results,
    'the dormant conversation view offers the wake action',
    Boolean(await app.client.evaluate(WAKE_IN_STAGE)),
    `stage text=${JSON.stringify(state.text.slice(0, 120))}`,
  )
}


/**
 * **送出 ≠ agent 收到。**
 *
 * 在它出現於紀錄中之前一律標示為未確認 —— 直接畫成一則已送達的訊息的話，兩者一致時看不出差別，
 * 不一致時（agent 沒收到、或收到的與送出的不同）使用者會看見**一則從未發生的訊息**。
 *
 * fixture：替身延遲數秒才把使用者訊息補進紀錄，於是「未確認 → 已確認」這個轉換觀察得到。
 */
async function runUnconfirmed(_mode, _config, context) {
  if (context.app) await context.app.close()
  const repo = mkTemp('spekterm-agentview-repo4-')
  const configDir = mkTemp('spekterm-agentview-config4-')
  const stub = makeStubAgent(mkTemp, configDir, { echoDelaySeconds: 4 })
  const profile = seedProfile(repo)
  const app = await launch({ profile, configDir, stub, port: PORT })
  context.app = app

  await createAgentSession(app, repo.split('/').pop())
  await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.hasToggle,
    timeoutMs: 25_000,
    label: 'session 建立',
  })
  await app.client.evaluate(TOGGLE_VIEW)
  await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.hasComposer,
    timeoutMs: 15_000,
    label: '切到對話 view',
  })
  await app.client.evaluate(`(() => {
    const box = document.querySelector('${label('conversation.composer')}')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(box, 'PENDING-PROBE')
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.sendDisabled === false,
    timeoutMs: 25_000,
    label: '等待狀態允許送出',
  })
  await app.client.evaluate(`document.querySelector('${label('conversation.send')}').click()`)

  /*
    **比對要忽略大小寫。**

    `innerText` 回傳的是**套用過 CSS `text-transform` 之後**的文字，而這個標籤帶著
    `uppercase` —— 畫面上是 `NOT CONFIRMED YET`，字典裡是 `Not confirmed yet`，
    直接 `includes()` 永遠對不上。同一段畫面裡的 `YOU`（字典寫的是 `You`）就是證據。

    這與本 repo「文案即選擇器」那條紀律同族：**選擇器取自字典是對的，但畫面上的文字未必逐字
    等於字典裡的值**。以 `aria-label` 定位不受影響（屬性值不經 CSS），以 `innerText` 比對才會。
  */
  const marker = copy('conversation.unconfirmed').toUpperCase()
  const pendingShown = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.text.toUpperCase().includes(marker),
    timeoutMs: 10_000,
    label: '送出後立即標示為未確認',
  })
  check(
    results,
    '送出的內容在抵達紀錄之前標示為未確認',
    pendingShown.text.toUpperCase().includes(marker),
    `畫面上出現「${marker}」`,
  )

  const confirmed = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => !state.text.toUpperCase().includes(marker) && state.text.includes('PENDING-PROBE'),
    timeoutMs: 25_000,
    label: '內容出現於紀錄後標示消失',
  })
  check(
    results,
    '內容出現於 agent 的紀錄之後，未確認的標示消失',
    !confirmed.text.toUpperCase().includes(marker) && confirmed.text.includes('PENDING-PROBE'),
    `仍標示未確認＝${confirmed.text.toUpperCase().includes(marker)}，訊息已呈現＝${confirmed.text.includes('PENDING-PROBE')}`,
  )
}


/** 建好一個 agent session 並切到對話 view。回傳當下的畫面狀態。 */
async function openConversation(app, repoName) {
  await createAgentSession(app, repoName)
  await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.hasToggle,
    timeoutMs: 25_000,
    label: 'session 建立',
  })
  await app.client.evaluate(TOGGLE_VIEW)
  return pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.hasComposer || state.text.includes(copy('conversation.unavailable')),
    timeoutMs: 20_000,
    label: '切到對話 view',
  })
}

async function typeDraft(app, text) {
  await app.client.evaluate(`(() => {
    const box = document.querySelector('${label('conversation.composer')}')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(box, ${JSON.stringify(text)})
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
}

/**
 * 控制位元組**一律以 escape 序列書寫**，不寫字面的位元組。
 *
 * 字面的控制位元組會讓 `git diff` 與 `grep` 對整個檔案瞎掉（本 repo 已在四個檔案上踩過），
 * 而且它們在 review 的畫面上是隱形的 —— 這一段正好是在驗「控制位元組要被濾掉」，
 * 用字面值寫它格外諷刺（實測：本次撰寫時連續兩度不小心寫成字面值，被工具擋下）。
 */
const CTRL_SAMPLE = `CTRL-PROBE\u0001a\u0007b`
// eslint-disable-next-line no-control-regex
const CTRL_PATTERN = /[\u0001-\u0008]/

/**
 * **許可提示出現時拒絕自由文字，並說出正在被問什麼。**
 *
 * 這是本 change 失效後果最嚴重的一條 —— 而使用者的 `defaultMode` 通常是 `auto`，日常幾乎不會
 * 走到它（design D7b 的覆蓋風險）。因此它**必須**由探針主動觸發，不能倚賴自然使用去發現。
 *
 * 順帶驗控制字元：送出的內容不得因控制位元組而中斷或消失。
 */
async function runAwaitingChoice(_mode, _config, context) {
  if (context.app) await context.app.close()
  const repo = mkTemp('spekterm-agentview-repo5-')
  const configDir = mkTemp('spekterm-agentview-config5-')
  const stub = makeStubAgent(mkTemp, configDir, { holdPermission: true })
  const profile = seedProfile(repo)
  const app = await launch({ profile, configDir, stub, port: PORT })
  context.app = app

  await openConversation(app, repo.split('/').pop())
  await typeDraft(app, CTRL_SAMPLE)
  await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.sendDisabled === false,
    timeoutMs: 25_000,
    label: '等待狀態允許送出',
  })
  await app.client.evaluate(`document.querySelector('${label('conversation.send')}').click()`)

  const arrived = await pollFor({
    read: () => stub.input(),
    settled: (text) => text.includes('CTRL-PROBE'),
    timeoutMs: 15_000,
    label: '含控制字元的內容仍然抵達 pty',
  })
  check(
    results,
    '含控制字元的輸入不使訊息消失（控制位元組被濾掉，本文抵達）',
    arrived.includes('CTRL-PROBEab') && !CTRL_PATTERN.test(arrived),
    `替身收到：${JSON.stringify(arrived.trim().slice(0, 40))}`,
  )

  const asking = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.text.includes('terminal view') && state.sendDisabled === true,
    timeoutMs: 25_000,
    label: '許可請求使畫面說出正在被問什麼且停用送出',
  })
  check(
    results,
    '等待選擇時呈現「正在被問什麼」並指向終端 view',
    asking.text.includes('terminal view'),
    `畫面＝${JSON.stringify(asking.text.slice(-160))}`,
  )

  await typeDraft(app, 'SHOULD-NOT-ARRIVE-2')
  const blocked = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.sendDisabled === true,
    timeoutMs: 15_000,
    label: '等待選擇時送出停用',
  })
  check(results, '等待選擇時自由文字送不出去', blocked.sendDisabled === true, '送出按鈕為停用')
  check(
    results,
    '此 view 不提供作答的入口（事件不含選項，猜編號就是猜畫面）',
    !blocked.text.includes('Yes, and') && !blocked.text.includes('No, and tell'),
    '畫面上沒有任何選項按鈕',
  )
  check(
    results,
    '被擋下的自由文字沒有抵達 pty',
    !stub.input().includes('SHOULD-NOT-ARRIVE-2'),
    `替身收到的輸入不含它＝${!stub.input().includes('SHOULD-NOT-ARRIVE-2')}`,
  )
}

/**
 * 內容不完整時**明示** —— 一份看起來完整、實際少了開頭的對話會誤導判斷；
 * 一個安靜地什麼都不顯示的 view 與「這個 session 還沒講話」無法區分。
 */
async function runIncompleteContent(_mode, _config, context) {
  if (context.app) await context.app.close()

  const repoA = mkTemp('spekterm-agentview-repo6-')
  const configA = mkTemp('spekterm-agentview-config6-')
  const bulkStub = makeStubAgent(mkTemp, configA, { bulkRecords: 500 })
  const profileA = seedProfile(repoA)
  const appA = await launch({ profile: profileA, configDir: configA, stub: bulkStub, port: PORT })
  context.app = appA
  const bulk = await openConversation(appA, repoA.split('/').pop())
  const truncated = await pollFor({
    read: () => appA.client.evaluate(VIEW_STATE),
    settled: (state) => state.text.includes(copy('conversation.earlierNotLoaded')),
    timeoutMs: 25_000,
    label: '超過上限時明示較早的內容未載入',
  })
  check(
    results,
    '長對話只載入最近一段，並明示較早的未載入',
    truncated.text.includes(copy('conversation.earlierNotLoaded')) && bulk.hasComposer,
    '畫面上出現「較早的內容未載入」的說明',
  )

  await appA.close()
  const repoB = mkTemp('spekterm-agentview-repo7-')
  const configB = mkTemp('spekterm-agentview-config7-')
  const brokenStub = makeStubAgent(mkTemp, configB, { unreadable: true })
  const profileB = seedProfile(repoB)
  const appB = await launch({ profile: profileB, configDir: configB, stub: brokenStub, port: RESTORE_PORT })
  context.app = appB
  await openConversation(appB, repoB.split('/').pop())
  const unavailable = await pollFor({
    read: () => appB.client.evaluate(VIEW_STATE),
    settled: (state) => state.text.includes(copy('conversation.unavailable')),
    timeoutMs: 25_000,
    label: '來源讀不到時明說',
  })
  check(
    results,
    '來源不可讀時明說原因並指向終端 view，不靜默呈現為「沒有內容」',
    unavailable.text.includes(copy('conversation.unavailable')) && unavailable.text.includes('terminal view'),
    `畫面＝${JSON.stringify(unavailable.text.slice(0, 120))}`,
  )
  check(
    results,
    '來源不可讀時 pty 不受影響（終端 view 照常可用）',
    unavailable.hasToggle,
    `切換入口仍在＝${unavailable.hasToggle}`,
  )
}


/**
 * **第四種轉換：另一種呈現覆蓋於其上。**
 *
 * 保有版面盒子、失去可見、**不**銷毀、**不**失去掛載。`terminal-sessions` 既有的條文只寫了
 * 顯示↔隱藏與銷毀三種 —— 而它自己已經指出「銷毀是獨立於顯示↔隱藏之外的第三種轉換，因此需要
 * 各自的條文與各自的驗收」，同一個理由在此適用。
 *
 * **判準必須是資源自身的失效狀態。** 該 requirement 明文禁止用「取得資源時新增了哪些節點」
 * 當額度歸還的證據 —— 那個判準在額度未歸還時依然全綠。
 *
 * **這條路帶著一個比其餘路徑更強的掩蓋機制**：切換呈現方式必然把輸入焦點交給輸入框，而失焦
 * 會讓底層套件自己暫停週期性工作。既有 spec 記載那個掩蓋在點擊分頁時尚可用鍵盤繞開；
 * **在這裡繞不開 —— 焦點轉移就是切換本身**。因此觀察的是脈絡，不是計時器。
 *
 * 探針**持有脈絡的參照**，於是觀察不受 GC 時機影響（沿用 `probe-terminal` 的同一條理由：
 * 未歸還額度的實作之所以多半沒出事，正是因為 GC 碰巧來得及）。
 */
async function runCoveredReleasesQuota(_mode, _config, context) {
  if (context.app) await context.app.close()
  const repo = mkTemp('spekterm-agentview-repo8-')
  const configDir = mkTemp('spekterm-agentview-config8-')
  const stub = makeStubAgent(mkTemp, configDir)
  const profile = seedProfile(repo)
  const app = await launch({ profile, configDir, stub, port: PORT })
  context.app = app
  await openConversation(app, repo.split('/').pop())

  const CAPTURE_SHOWN_GL = `(() => {${RENDER_PATH_PRELUDE}
    window.__probeGlCover = window.__probeGlCover ?? []
    const shown = hostsOf().filter((d) => !d.classList.contains('hidden'))
    const host = shown[0]
    if (!host) return 'no-shown-host'
    const screen = host.querySelector('.xterm-screen')
    const main = screen
      ? [...screen.querySelectorAll('canvas')].find((c) => !c.classList.contains('xterm-link-layer'))
      : null
    const gl = main ? main.getContext('webgl2') : null
    if (!gl) return 'no-context'
    window.__probeGlCover.push(gl)
    return 'captured'
  })()`
  const LOST = `window.__probeGlCover.map((gl) => (gl ? gl.isContextLost() : null))`

  // 先切回終端 view 取得一份脈絡，再覆蓋它。
  await app.client.evaluate(TOGGLE_VIEW)
  await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => !state.hasComposer,
    timeoutMs: 15_000,
    label: '回到終端 view',
  })
  const captured = await pollFor({
    read: () => app.client.evaluate(CAPTURE_SHOWN_GL),
    settled: (r) => r === 'captured',
    timeoutMs: 15_000,
    label: '抓住顯示中終端的渲染資源',
  })
  check(results, '前提：顯示中的終端確實持有一份渲染資源', captured === 'captured', `抓取結果＝${captured}`)

  await app.client.evaluate(TOGGLE_VIEW)
  const lostAfterCover = await pollFor({
    read: () => app.client.evaluate(LOST),
    settled: (list) => list[list.length - 1] === true,
    timeoutMs: 15_000,
    label: '覆蓋之後該資源失效（額度歸還）',
  })
  check(
    results,
    '另一種呈現覆蓋其上時，終端歸還其渲染資源的並存額度',
    lostAfterCover[lostAfterCover.length - 1] === true,
    `lost=${JSON.stringify(lostAfterCover)}`,
  )

  // 反覆切換：每次切回終端取得一份新脈絡，每次覆蓋都必須歸還它。
  // 未歸還的實作會讓它們全部保持有效 —— 那正是「累積佔用」的樣子。
  for (let round = 0; round < 4; round += 1) {
    await app.client.evaluate(TOGGLE_VIEW)
    await pollFor({
      read: () => app.client.evaluate(CAPTURE_SHOWN_GL),
      settled: (r) => r === 'captured',
      timeoutMs: 15_000,
      label: `第 ${round + 2} 次取得渲染資源`,
    })
    await app.client.evaluate(TOGGLE_VIEW)
    await pollFor({
      read: () => app.client.evaluate(LOST),
      settled: (list) => list[list.length - 1] === true,
      timeoutMs: 15_000,
      label: `第 ${round + 2} 次覆蓋後歸還`,
    })
  }
  const allLost = await app.client.evaluate(LOST)
  check(
    results,
    '反覆切換呈現方式不累積佔用（每一份取得的資源都被歸還）',
    allLost.length >= 5 && allLost.every((lost) => lost === true),
    `取得 ${allLost.length} 份，lost=${JSON.stringify(allLost)}`,
  )

  // 切回終端 view 之後仍必須拿得到一份**有效**的資源 —— 釋放若做過頭，症狀在這裡。
  await app.client.evaluate(TOGGLE_VIEW)
  const alive = await pollFor({
    read: () =>
      app.client.evaluate(`(() => {${RENDER_PATH_PRELUDE}
        const shown = hostsOf().filter((d) => !d.classList.contains('hidden'))
        return shown.map((host) => renderPathOf(host))
      })()`),
    settled: (paths) => paths.includes('programmatic'),
    timeoutMs: 15_000,
    label: '切回終端 view 後仍走程式化繪製',
  })
  check(
    results,
    '切回終端 view 後重新取得有效的渲染資源（釋放沒有做過頭）',
    alive.includes('programmatic'),
    `渲染路徑＝${JSON.stringify(alive)}`,
  )
}


/** 在對話 view 裡填入草稿並送出（等待狀態允許之後）。 */
async function sendFromConversation(app, text) {
  await typeDraft(app, text)
  await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.sendDisabled === false,
    timeoutMs: 25_000,
    label: '等待狀態允許送出',
  })
  await app.client.evaluate(`document.querySelector('${label('conversation.send')}').click()`)
}

/**
 * **agent 在 pty 之內換掉紀錄時，跟進必須跟著換。**
 *
 * 使用者於 agent 之內清空或切換對話會指派一份新的紀錄 —— 而那**發生在 pty 之內**：pty 沒死、
 * 自癒沒觸發，spekterm 收不到任何自己發出的訊號。唯一的線索是事件帶來的 `transcript_path`。
 *
 * 漏掉這條的失效**特別惡劣**：跟進器停在一份不再成長的檔上，落進「等它出現」而**永遠等下去**，
 * 且不算失敗。畫面就是一份安靜停住的對話，而終端裡 agent 明明在跑。
 *
 * 替身順帶送出 `SessionEnd` —— **它不代表 session 結束**（實測 `/clear` 就會發它而 pty 還活著）。
 * 把它接上拆除的實作，會在這一段之後再也收不到任何內容。
 */
async function runRelocateByEvent(_mode, _config, context) {
  if (context.app) await context.app.close()
  const repo = mkTemp('spekterm-agentview-repo9-')
  const configDir = mkTemp('spekterm-agentview-config9-')
  const stub = makeStubAgent(mkTemp, configDir, { relocateAfterInput: true })
  const profile = seedProfile(repo)
  const app = await launch({ profile, configDir, stub, port: PORT })
  context.app = app

  await openConversation(app, repo.split('/').pop())
  // **前提要等內容真的到** —— `hasComposer` 只代表 view 掛上了，早於任何內容抵達。
  // 少了這道等待，前提會在「內容尚未到達」時就判紅，而它其實只是還沒到。
  const opened = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.text.includes('STUB-HELLO-'),
    timeoutMs: 25_000,
    label: '原本那一份紀錄的內容抵達',
  })
  check(results, '前提：跟進的是原本那一份紀錄', opened.text.includes('STUB-HELLO-'), '原本的內容已呈現')

  await sendFromConversation(app, 'TRIGGER-RELOCATE')
  const relocated = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.text.includes('RELOCATED-MARKER'),
    timeoutMs: 25_000,
    label: '事件回報新位置後，跟進改換來源',
  })
  check(
    results,
    'agent 於 pty 之內換掉紀錄時，跟進以事件回報的位置改換來源',
    relocated.text.includes('RELOCATED-MARKER'),
    '新紀錄的內容已呈現',
  )
  check(
    results,
    '「對話結束」的事件沒有把跟進拆掉（它不代表 session 結束）',
    relocated.hasComposer && relocated.hasToggle,
    `輸入框＝${relocated.hasComposer}，切換入口＝${relocated.hasToggle}`,
  )
}

/**
 * 忙碌狀態來自 agent 自己回報的事件，**不由畫面推測、也不模擬產生過程**。
 */
async function runBusyIndicator(_mode, _config, context) {
  if (context.app) await context.app.close()
  const repo = mkTemp('spekterm-agentview-repoA-')
  const configDir = mkTemp('spekterm-agentview-configA-')
  const stub = makeStubAgent(mkTemp, configDir, { busySeconds: 4 })
  const profile = seedProfile(repo)
  const app = await launch({ profile, configDir, stub, port: PORT })
  context.app = app

  await openConversation(app, repo.split('/').pop())
  await sendFromConversation(app, 'MAKE-IT-BUSY')

  const busy = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.text.toUpperCase().includes(copy('conversation.busy').toUpperCase()),
    timeoutMs: 20_000,
    label: 'agent 宣告忙碌後畫面呈現忙碌',
  })
  check(
    results,
    'agent 回報忙碌時畫面呈現忙碌',
    busy.text.toUpperCase().includes(copy('conversation.busy').toUpperCase()),
    '畫面上出現忙碌指示',
  )
  /*
    忙碌時**仍然允許送出** —— agent 本來就接受在它工作時打字（會排隊），拒絕會很難用。

    **必須先打新的草稿再問。** 送出之後草稿被清空，而空草稿時送出鈕本來就是停用的 ——
    不重新打字就斷言，量到的是「草稿是不是空的」，不是「等待狀態允不允許」。
  */
  await typeDraft(app, 'WHILE-BUSY')
  const busyWithDraft = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.sendDisabled !== null,
    timeoutMs: 10_000,
    label: '忙碌中重新打字',
  })
  check(
    results,
    '忙碌時送出仍然可用（打了草稿之後）',
    busyWithDraft.sendDisabled === false,
    `送出停用＝${busyWithDraft.sendDisabled}`,
  )

  const idle = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => !state.text.toUpperCase().includes(copy('conversation.busy').toUpperCase()),
    timeoutMs: 25_000,
    label: 'agent 宣告就緒後忙碌指示消失',
  })
  check(
    results,
    'agent 回報就緒後忙碌指示消失',
    !idle.text.toUpperCase().includes(copy('conversation.busy').toUpperCase()),
    '忙碌指示已消失',
  )
}

/**
 * **A text-only answer shows busy** (`agent-event-bridge`, companion-test-fixes).
 *
 * The stub writes its answer after `answerSeconds` and reports no tool event at all, so the only thing that
 * can make the state busy is the submission event itself. `runBusyIndicator` cannot carry this: its stub
 * fires `PreToolUse`, which was busy before this change too.
 */
async function runTextOnlyBusy(_mode, _config, context) {
  if (context.app) await context.app.close()
  const repo = mkTemp('spekterm-agentview-repoT-')
  const configDir = mkTemp('spekterm-agentview-configT-')
  const stub = makeStubAgent(mkTemp, configDir, { answerSeconds: 5 })
  const profile = seedProfile(repo)
  const app = await launch({ profile, configDir, stub, port: PORT })
  context.app = app

  await openConversation(app, repo.split('/').pop())
  await sendFromConversation(app, 'TEXT-ONLY-PROBE')
  const busyText = copy('conversation.busy').toUpperCase()
  const busy = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.text.toUpperCase().includes(busyText),
    timeoutMs: 15_000,
    label: 'a text-only answer shows busy',
  })
  check(
    results,
    'a text-only answer (no tool event) shows the agent busy',
    busy.text.toUpperCase().includes(busyText),
    `busy shown=${busy.text.toUpperCase().includes(busyText)}`,
  )
  const done = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.text.includes('STUB-ANSWER-1') && !state.text.toUpperCase().includes(busyText),
    timeoutMs: 25_000,
    label: 'the answer arrives and busy clears',
  })
  check(
    results,
    'the busy indicator clears when the answer ends',
    done.text.includes('STUB-ANSWER-1') && !done.text.toUpperCase().includes(busyText),
    `answer shown=${done.text.includes('STUB-ANSWER-1')}, still busy=${done.text.toUpperCase().includes(busyText)}`,
  )
}

/** Every user entry in the conversation view: its label (as written, not as CSS-transformed) and its text. */
const USER_ENTRIES = `(() => {
  const stage = document.querySelector('[aria-label="${copy('stage.terminal')}"]')
  const labels = new Set([${JSON.stringify(copy('conversation.userMessage'))}, ${JSON.stringify(copy('conversation.metaMessage'))}])
  return [...(stage?.querySelectorAll('.conversation-enter') ?? [])]
    .map((row) => ({ label: row.firstElementChild?.textContent ?? '', text: row.textContent ?? '' }))
    .filter((entry) => labels.has(entry.label))
})()`

/**
 * **A message delivered mid-turn is the user's; a background-task notice is not** (`agent-transcript-stream`).
 *
 * The stub records the sent line only as a `queued_command` attachment (`queuedDelivery`), never as a `user`
 * record — so the "not confirmed" label can clear, and the text can show under "You", only through the
 * attachment's projection. The notice is a `user` record shaped like the agent's (system prompt source,
 * non-human origin, no `isMeta`), appended by the stub on request.
 */
async function runMidTurnDelivery(_mode, _config, context) {
  if (context.app) await context.app.close()
  const repo = mkTemp('spekterm-agentview-repoQ-')
  const configDir = mkTemp('spekterm-agentview-configQ-')
  const stub = makeStubAgent(mkTemp, configDir, { queuedDelivery: true, echoDelaySeconds: 3 })
  const profile = seedProfile(repo)
  const app = await launch({ profile, configDir, stub, port: PORT })
  context.app = app

  await openConversation(app, repo.split('/').pop())
  const conversation = stub.peerNames().at(-1)?.conversation
  await sendFromConversation(app, 'MIDTURN-PROBE')
  const marker = copy('conversation.unconfirmed').toUpperCase()
  const confirmed = await pollFor({
    read: () => app.client.evaluate(`({ view: ${VIEW_STATE}, entries: ${USER_ENTRIES} })`),
    settled: (state) =>
      !state.view.text.toUpperCase().includes(marker) && state.entries.some((e) => e.text.includes('MIDTURN-PROBE')),
    timeoutMs: 25_000,
    label: 'the mid-turn delivery appears and confirms the sent message',
  })
  const delivered = confirmed.entries.find((e) => e.text.includes('MIDTURN-PROBE'))
  check(
    results,
    'a message recorded as a mid-turn delivery shows as the user\'s message',
    delivered?.label === copy('conversation.userMessage'),
    `label=${JSON.stringify(delivered?.label ?? null)}`,
  )
  check(
    results,
    'the mid-turn delivery clears the "not confirmed" label',
    !confirmed.view.text.toUpperCase().includes(marker),
    `still unconfirmed=${confirmed.view.text.toUpperCase().includes(marker)}`,
  )

  stub.command(
    conversation,
    `printf '%s\\n' '{"type":"user","uuid":"notice-1","timestamp":"2026-09-06T00:00:03.000Z","promptSource":"system","origin":{"kind":"task-notification","producer":"session-task"},"message":{"role":"user","content":"<task-notification><task-id>NOTICE-PROBE</task-id><status>completed</status></task-notification>"}}' >> "$tp"`,
  )
  const noticed = await pollFor({
    read: () => app.client.evaluate(USER_ENTRIES),
    settled: (entries) => entries.some((e) => e.text.includes('NOTICE-PROBE')),
    timeoutMs: 15_000,
    label: 'the task notice arrives',
  })
  const notice = noticed.find((e) => e.text.includes('NOTICE-PROBE'))
  check(
    results,
    'a background-task notice is not shown as the user\'s message',
    notice?.label === copy('conversation.metaMessage'),
    `label=${JSON.stringify(notice?.label ?? null)}`,
  )
}

/**
 * Automatic hibernation of agent sessions (session-hibernation design D4), threshold seeded as
 * seconds. Which sessions an agent's state keeps running depends on that state being current for
 * sessions nobody watches — the always-on subscription. Two sessions carry it: one never watched (it
 * reads `unknown` without the subscription, so it is never hibernated) and one watched until it was
 * waiting, then left and given work (it reads a stale `ready` without the subscription, so it is
 * hibernated mid-work).
 */
async function runAutoHibernateAgent(_mode, _config, context) {
  if (context.app) await context.app.close()
  const THRESHOLD_S = 5
  const repo = mkTemp('spekterm-agentview-repoH-')
  const configDir = mkTemp('spekterm-agentview-configH-')
  const stub = makeStubAgent(mkTemp, configDir)
  const profile = seedProfile(repo)
  writeFileSync(
    join(profile, 'preferences.json'),
    JSON.stringify({ version: 1, terminal: { autoHibernateSeconds: THRESHOLD_S }, ui: { language: 'en' } }),
  )
  const app = await launch({ profile, configDir, stub, port: PORT })
  context.app = app
  const repoName = repo.split('/').pop()

  /** Create an agent session and return its conversation id (the stub logs each start). */
  const create = async () => {
    const before = stub.peerNames().length
    await createAgentSession(app, repoName)
    const names = await pollFor({
      read: () => stub.peerNames(),
      settled: (list) => list.length > before,
      timeoutMs: 20_000,
      label: 'the new agent starts',
    })
    return names.at(-1).conversation
  }

  // A: idle, never shown in the conversation view.
  const idle = await create()
  // B: shown in the conversation view until it reports waiting.
  const watched = await create()
  await app.client.evaluate(TOGGLE_VIEW)
  await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.text.includes(`STUB-HELLO-${watched}`),
    timeoutMs: 20_000,
    label: 'B is watched and its content arrived',
  })
  await new Promise((resolve) => setTimeout(resolve, 1000))
  // D: leaves B; B is then given work that never ends while nobody watches it.
  const choosing = await create()
  stub.command(watched, 'fire PreToolUse')
  // E: leaves D; D then waits on a permission choice.
  await create()
  stub.command(choosing, 'fire PermissionRequest')

  const idleGone = await pollFor({
    read: () => agentAlive(idle),
    settled: (alive) => alive === false,
    timeoutMs: (THRESHOLD_S + 12) * 1000,
    interval: 250,
    label: 'the idle, never-watched agent is hibernated',
  })
  check(results, 'an idle agent that was never watched is hibernated after the threshold', idleGone === false, `alive=${idleGone}`)

  await new Promise((resolve) => setTimeout(resolve, (THRESHOLD_S + 3) * 1000))
  const kept = { working: agentAlive(watched), choosing: agentAlive(choosing) }
  check(results, 'an agent that started working while unwatched stays running (no stale ready)', kept.working, JSON.stringify(kept))
  check(results, 'an agent waiting on a permission choice stays running', kept.choosing, JSON.stringify(kept))

  // F: the conversation relocates while nobody watches it; opening its view follows the new file.
  const relocating = await create()
  await create()
  stub.command(
    relocating,
    [
      'tp="$dir/relocated-$sid.jsonl"',
      `printf '%s\n' '{"type":"assistant","uuid":"ru1","timestamp":"2026-09-06T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"RELOCATED-UNWATCHED"}]}}' >> "$tp"`,
      'fire SessionEnd',
      'fire SessionStart',
    ].join('\n'),
  )
  await new Promise((resolve) => setTimeout(resolve, 1500))
  await app.client.evaluate(focusTabExpression(4))
  const relocated = await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.text.includes('RELOCATED-UNWATCHED'),
    timeoutMs: 10_000,
    label: 'the view follows a relocation that happened while unwatched',
  })
  check(
    results,
    'opening the conversation view follows a relocation reported while nobody watched',
    relocated.text.includes('RELOCATED-UNWATCHED'),
    `view text=${JSON.stringify(relocated.text.slice(0, 160))}`,
  )
}

/**
 * The maximized side panel covers the terminal (`maximize-panel-and-confirm-close`): the same
 * transition as the conversation view on top — the terminal keeps its box, loses visibility, and
 * must return its renderer share (`terminal-sessions`). Observed the same way as above: the context
 * the probe holds is lost. Also the focus rules of design M2: restoring hands focus to the
 * conversation input, and a covered conversation view never takes focus (a dormant one would put it
 * on a Wake button nobody sees).
 */
async function runMaximizeCover(_mode, _config, context) {
  if (context.app) await context.app.close()
  const repo = mkTemp('spekterm-agentview-repo-max-')
  const configDir = mkTemp('spekterm-agentview-config-max-')
  const stub = makeStubAgent(mkTemp, configDir)
  const profile = seedProfile(repo)
  const app = await launch({ profile, configDir, stub, port: PORT })
  context.app = app
  await openConversation(app, repo.split('/').pop())

  const ENTRY = `document.querySelector('[aria-label="${copy('stage.maximizeSidePanel')}"], [aria-label="${copy('stage.restoreSidePanel')}"]')`
  const MAXIMIZED = `${ENTRY}?.getAttribute('aria-pressed') === 'true'`
  const toggleMaximized = async (want) => {
    await app.client.evaluate(`${ENTRY}?.click()`)
    return pollFor({ read: () => app.client.evaluate(MAXIMIZED), settled: (v) => v === want, timeoutMs: 5000, label: `maximized=${want}` })
  }
  const CAPTURE_SHOWN_GL = `(() => {${RENDER_PATH_PRELUDE}
    window.__probeGlMax = window.__probeGlMax ?? []
    const shown = hostsOf().filter((d) => !d.classList.contains('hidden'))
    const host = shown[0]
    if (!host) return 'no-shown-host'
    const screen = host.querySelector('.xterm-screen')
    const main = screen
      ? [...screen.querySelectorAll('canvas')].find((c) => !c.classList.contains('xterm-link-layer'))
      : null
    const gl = main ? main.getContext('webgl2') : null
    if (!gl) return 'no-context'
    window.__probeGlMax.push(gl)
    return 'captured'
  })()`
  const LOST = `window.__probeGlMax.map((gl) => (gl ? gl.isContextLost() : null))`
  const FOCUS = `(() => {
    const el = document.activeElement
    if (!el || el === document.body) return 'body'
    if (el.matches('${label('conversation.composer')}')) return 'composer'
    if (el.tagName === 'BUTTON' && el.textContent === ${JSON.stringify(copy('sessions.wake'))}) return 'wake'
    if (document.querySelector('section[aria-label="${copy('openspec.sidePanel')}"]')?.contains(el)) return 'panel'
    if (el.closest('.xterm')) return 'terminal'
    return el.tagName.toLowerCase()
  })()`

  // ── GPU share: terminal view, capture, maximize ⇒ lost; restore ⇒ held again ──
  await app.client.evaluate(TOGGLE_VIEW)
  await pollFor({ read: () => app.client.evaluate(VIEW_STATE), settled: (state) => !state.hasComposer, timeoutMs: 15_000, label: 'terminal view' })
  const captured = await pollFor({ read: () => app.client.evaluate(CAPTURE_SHOWN_GL), settled: (r) => r === 'captured', timeoutMs: 15_000, label: 'capture the shown terminal context' })
  check(results, '[maximize] precondition: the shown terminal holds a renderer context', captured === 'captured', `capture=${captured}`)
  await toggleMaximized(true)
  const lost = await pollFor({ read: () => app.client.evaluate(LOST), settled: (list) => list[list.length - 1] === true, timeoutMs: 15_000, label: 'context lost under the cover' })
  check(results, '[maximize] the covered terminal returns its renderer share', lost[lost.length - 1] === true, `lost=${JSON.stringify(lost)}`)
  await toggleMaximized(false)
  const again = await pollFor({ read: () => app.client.evaluate(CAPTURE_SHOWN_GL), settled: (r) => r === 'captured', timeoutMs: 15_000, label: 'context again after restore' })
  const newest = await app.client.evaluate(LOST)
  check(results, '[maximize] after restoring the terminal holds a renderer again', again === 'captured' && newest[newest.length - 1] === false,
    `capture=${again} lost=${JSON.stringify(newest)}`)

  // ── Restoring returns focus to the conversation input ──
  await app.client.evaluate(TOGGLE_VIEW)
  await pollFor({ read: () => app.client.evaluate(VIEW_STATE), settled: (state) => state.hasComposer, timeoutMs: 15_000, label: 'conversation view' })
  await toggleMaximized(true)
  const focusMax = await pollFor({ read: () => app.client.evaluate(FOCUS), settled: (v) => v === 'panel', timeoutMs: 3000, label: 'focus in the panel' })
  await toggleMaximized(false)
  const focusBack = await pollFor({ read: () => app.client.evaluate(FOCUS), settled: (v) => v === 'composer', timeoutMs: 3000, label: 'focus in the composer' })
  check(results, '[maximize] restoring returns focus to the conversation input', focusMax === 'panel' && focusBack === 'composer',
    `maximized=${focusMax} restored=${focusBack}`)

  // ── A covered conversation view takes no focus: hibernate under the cover ──
  await toggleMaximized(true)
  for (const type of ['rawKeyDown', 'keyUp']) {
    await app.client.send('Input.dispatchKeyEvent', { type, key: 'H', code: 'KeyH', windowsVirtualKeyCode: 72, nativeVirtualKeyCode: 72, modifiers: 2 | 8 })
  }
  const dormant = await pollFor({ read: () => app.client.evaluate(WAKE_IN_STAGE), settled: (v) => v === true, timeoutMs: 8000, label: 'dormant under the cover' })
  await new Promise((resolve) => setTimeout(resolve, 600))
  const focusDormant = await app.client.evaluate(FOCUS)
  const stillMax = await app.client.evaluate(MAXIMIZED)
  check(results, '[maximize] a covered dormant conversation view does not take focus',
    dormant === true && stillMax === true && focusDormant !== 'wake', `dormant=${dormant} maximized=${stillMax} focus=${focusDormant}`)
  await toggleMaximized(false)
  const focusWake = await pollFor({ read: () => app.client.evaluate(FOCUS), settled: (v) => v === 'wake', timeoutMs: 3000, label: 'focus on Wake after restore' })
  check(results, '[maximize] restoring a dormant conversation view focuses its Wake button', focusWake === 'wake', `focus=${focusWake}`)
}

/**
 * The close confirmation marks a working agent (workspace-app-shell, "A working agent is marked").
 * The native dialog is the stand-in in src/main/close-dialog-stub.ts (throwaway profile): writing
 * close-stub/close makes the main process close the window as its close button does, and the prompt
 * is read back from close-stub/dialogs.jsonl.
 */
async function runCloseConfirmAgent(_mode, _config, context) {
  if (context.app) await context.app.close()
  const repo = mkTemp('spekterm-agentview-repoC-')
  const configDir = mkTemp('spekterm-agentview-configC-')
  const stub = makeStubAgent(mkTemp, configDir, { busySeconds: 30 })
  const profile = seedProfile(repo)
  const app = await launch({ profile, configDir, stub, port: PORT })
  context.app = app
  const repoName = repo.split('/').pop()
  const root = join(profile, 'close-stub')
  const dialogs = () => {
    try {
      return readFileSync(join(root, 'dialogs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }

  await openConversation(app, repoName)
  await sendFromConversation(app, 'MAKE-IT-BUSY')
  await pollFor({
    read: () => app.client.evaluate(VIEW_STATE),
    settled: (state) => state.text.toUpperCase().includes(copy('conversation.busy').toUpperCase()),
    timeoutMs: 20_000,
    label: 'the agent reports working',
  })

  writeFileSync(join(root, 'answer'), 'cancel')
  writeFileSync(join(root, 'close'), String(Date.now()))
  const prompts = await pollFor({
    read: dialogs,
    settled: (value) => value.length >= 1,
    timeoutMs: 8000,
    interval: 100,
    label: 'the close prompt',
  })
  const firstLine = (prompts[0]?.detail ?? '').split('\n')[0]
  const slot = 'LABEL_SLOT'
  const [prefix, suffix] = copy('closeConfirm.lineWorking', { item: repoName, label: slot }).split(slot)
  check(
    results,
    'a working agent is marked in the close confirmation',
    firstLine.startsWith(prefix) && firstLine.endsWith(suffix) && firstLine.length > prefix.length + suffix.length,
    `line=${JSON.stringify(firstLine)} expected ${JSON.stringify(prefix)}…${JSON.stringify(suffix)}`,
  )
}


const SECTIONS = [
  { name: 'runViewAndSend', run: runViewAndSend },
  { name: 'runRebuiltWidth', run: runRebuiltWidth, requires: ['runViewAndSend'] },
  { name: 'runReadableWithoutEvents', run: runReadableWithoutEvents },
  { name: 'runParallelSessions', run: runParallelSessions },
  { name: 'runDormantConversation', run: runDormantConversation, requires: ['runParallelSessions'] },
  { name: 'runUnconfirmed', run: runUnconfirmed },
  { name: 'runAwaitingChoice', run: runAwaitingChoice },
  { name: 'runIncompleteContent', run: runIncompleteContent },
  { name: 'runCoveredReleasesQuota', run: runCoveredReleasesQuota },
  { name: 'runMaximizeCover', run: runMaximizeCover },
  { name: 'runRelocateByEvent', run: runRelocateByEvent },
  { name: 'runBusyIndicator', run: runBusyIndicator },
  { name: 'runTextOnlyBusy', run: runTextOnlyBusy },
  { name: 'runMidTurnDelivery', run: runMidTurnDelivery },
  { name: 'runAutoHibernateAgent', run: runAutoHibernateAgent },
  { name: 'runCloseConfirmAgent', run: runCloseConfirmAgent },
]

const outcome = await runSections({
  sections: SECTIONS,
  build: { port: PORT, rendererUrl: null },
  dev: null,
  results,
  afterMode: async (_mode, context) => {
    if (context.app) await context.app.close()
  },
  cleanup: () => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true })
  },
})

process.exit(outcome.ok ? 0 : 1)
