import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import {
  PREFERENCES_VERSION,
  PreferencesStore,
  parsePreferences,
  projectPreferences,
  writePreferencesFileAtomic,
} from './preferences-store'

let base: string
let configPath: string

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'))
}

function corruptFiles(): string[] {
  return fs.readdirSync(base).filter((name) => name.includes('preferences.json.corrupt-'))
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'spek-prefs-')))
  configPath = path.join(base, 'preferences.json')
})

afterEach(() => {
  mock.restoreAll()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('parsePreferences：結構嚴格', () => {
  it('合法內容原樣解析', () => {
    const raw = JSON.stringify({ version: 1, terminal: { fontFamily: 'Fira Code', fontSize: 15 } })
    assert.deepEqual(parsePreferences(raw), {
      version: 1,
      terminal: { fontFamily: 'Fira Code', fontSize: 15 },
      // 本區塊加入之前寫下的檔案沒有 `ui` —— 缺席是合法的，讀入為空區塊。
      ui: {},
      updates: {},
    })
  })

  it('不是有效 JSON → null', () => {
    assert.equal(parsePreferences('{ not json'), null)
  })

  it('版本不符 → null（整檔不可信）', () => {
    assert.equal(parsePreferences(JSON.stringify({ version: 999, terminal: {} })), null)
  })

  it('terminal 不是物件 → null', () => {
    assert.equal(parsePreferences(JSON.stringify({ version: 1, terminal: 42 })), null)
    assert.equal(parsePreferences(JSON.stringify({ version: 1 })), null)
  })

  it('空 terminal 是合法的（＝全用預設）', () => {
    assert.deepEqual(parsePreferences(JSON.stringify({ version: 1, terminal: {} })), {
      version: 1,
      terminal: {},
      ui: {},
      updates: {},
    })
  })
})

describe('the removed handoff switch', () => {
  // `agentHandoff` existed until 2026-09-30 and was never shown in the UI. A file written by an
  // earlier version may still hold it; the field table drops fields it does not know.
  it('A preferences file with the removed switch still loads', () => {
    const raw = JSON.stringify({ version: 1, terminal: { fontSize: 15, agentHandoff: false } })

    const parsed = parsePreferences(raw)
    assert.ok(parsed, 'the file must not be rejected because of the old field')
    assert.deepEqual(parsed.terminal, { fontSize: 15 })
  })
})

describe('parsePreferences：值寬容（清理／夾制而非棄檔）', () => {
  it('fontSize 超出範圍被夾制，而非使整檔無效', () => {
    assert.equal(
      parsePreferences(JSON.stringify({ version: 1, terminal: { fontSize: 100 } }))?.terminal
        .fontSize,
      32,
    )
    assert.equal(
      parsePreferences(JSON.stringify({ version: 1, terminal: { fontSize: 2 } }))?.terminal
        .fontSize,
      8,
    )
  })

  it('fontSize 非有限數 → 省略（用預設），不棄檔', () => {
    const parsed = parsePreferences(
      JSON.stringify({ version: 1, terminal: { fontSize: 'big', fontFamily: 'Mono' } }),
    )
    assert.equal(parsed?.terminal.fontSize, undefined)
    assert.equal(parsed?.terminal.fontFamily, 'Mono')
  })

  it('fontFamily 保留含空白的字型名', () => {
    assert.equal(
      parsePreferences(JSON.stringify({ version: 1, terminal: { fontFamily: 'MesloLGS NF' } }))
        ?.terminal.fontFamily,
      'MesloLGS NF',
    )
  })

  it('fontFamily 剝除雙引號（會破壞 CSS font-family 字串）', () => {
    assert.equal(
      parsePreferences(
        JSON.stringify({ version: 1, terminal: { fontFamily: 'Evil", serif; x:' } }),
      )?.terminal.fontFamily,
      'Evil, serif; x:',
    )
  })

  it('fontFamily 非字串 → 省略', () => {
    assert.equal(
      parsePreferences(JSON.stringify({ version: 1, terminal: { fontFamily: 123 } }))?.terminal
        .fontFamily,
      undefined,
    )
  })

  it('lineHeight 超出範圍被夾制', () => {
    assert.equal(
      parsePreferences(JSON.stringify({ version: 1, terminal: { lineHeight: 5 } }))?.terminal
        .lineHeight,
      2,
    )
    assert.equal(
      parsePreferences(JSON.stringify({ version: 1, terminal: { lineHeight: 0.2 } }))?.terminal
        .lineHeight,
      1,
    )
  })

  it('lineHeight 是分數，不取整（1.2 不得變成 1）', () => {
    assert.equal(
      parsePreferences(JSON.stringify({ version: 1, terminal: { lineHeight: 1.2 } }))?.terminal
        .lineHeight,
      1.2,
    )
  })

  it('lineHeight 非有限數 → 省略（用預設）', () => {
    assert.equal(
      parsePreferences(JSON.stringify({ version: 1, terminal: { lineHeight: 'tall' } }))?.terminal
        .lineHeight,
      undefined,
    )
  })
})

describe('PreferencesStore：讀寫與持久化', () => {
  it('無設定檔時 get() 為空（全用預設）且不留 corrupt 檔', () => {
    const store = new PreferencesStore(configPath)
    store.load()
    assert.deepEqual(store.get(), {})
    assert.equal(corruptFiles().length, 0, '首次啟動不是損毀')
  })

  it('設定字型後 get() 反映，且帶版本欄位', () => {
    const store = new PreferencesStore(configPath)
    store.load()
    const applied = store.setTerminalFont('JetBrains Mono', 16, null)

    assert.deepEqual(applied, { fontFamily: 'JetBrains Mono', fontSize: 16 })
    assert.deepEqual(store.get(), { fontFamily: 'JetBrains Mono', fontSize: 16 })
    assert.equal(readConfig().version, PREFERENCES_VERSION)
  })

  it('GPU 加速：未設定即為啟用（省略而非寫入 true）', () => {
    const store = new PreferencesStore(configPath)
    store.load()

    assert.equal(store.get().gpuAcceleration, undefined, '未設定＝預設啟用，不占空間')
    store.setGpuAcceleration(false)
    assert.equal(store.get().gpuAcceleration, false)
    store.setGpuAcceleration(null)
    assert.equal(store.get().gpuAcceleration, undefined, 'null ＝清回預設')
  })

  it('設定字型不得抹掉 GPU 偏好', () => {
    // **這條守的是一個會靜默毀掉使用者設定的陷阱**：`setTerminalFont` 從一個空物件重建
    // `terminal` —— 少了保留邏輯，使用者關掉 GPU（因為驅動有問題、畫面是壞的）之後，
    // 只要再調一次字級，GPU 就自己開回來了，而那正是他關掉它的原因。
    const store = new PreferencesStore(configPath)
    store.load()
    store.setGpuAcceleration(false)

    store.setTerminalFont('Fira Code', 14, null)
    assert.equal(store.get().gpuAcceleration, false, '改字型不該動到 GPU 偏好')

    // 反向：改 GPU 不該抹掉字型。
    store.setGpuAcceleration(true)
    assert.deepEqual(store.get(), { fontFamily: 'Fira Code', fontSize: 14, gpuAcceleration: true })
  })

  it('agentStatus 跨一次 load() 還原（issue #39 的讀入那一半）', () => {
    // **這條與下一條是兩個不同的 bug，必須各驗一次。** 這一條守讀入路徑：漏在讀入白名單中的
    // 欄位寫得進磁碟卻讀不回來，於是下一次任何 setter 的 save() 整份重寫時把它從磁碟抹掉。
    // 症狀是「這個開關不跨重啟」，而只驗 setter 回傳值的測試照樣全綠。
    const first = new PreferencesStore(configPath)
    first.load()
    assert.equal(first.get().agentStatus, undefined, '前置：一開始是未設定')
    first.setAgentStatus(false)

    const second = new PreferencesStore(configPath)
    second.load()
    assert.equal(second.get().agentStatus, false)
  })

  it('設定字型不得抹掉 agentStatus（issue #39 的保留那一半）', () => {
    // **這條守部分更新路徑**：`setTerminalFont` 自空物件重建 `terminal`，未被保留的欄位於該次
    // 儲存中被抹除。它與上一條的失效方向相反 —— 只修讀取路徑而漏掉這裡，等於把「完全不生效」
    // 換成「調一次字型就失效」，而後者更難察覺，因為它在一段時間內是對的。
    const store = new PreferencesStore(configPath)
    store.load()
    store.setAgentStatus(false)

    store.setTerminalFont('Fira Code', 14, null)
    assert.equal(store.get().agentStatus, false, '改字型不該動到 agent 狀態橋接的開關')

    // 並且它要真的落盤 —— 不只是記憶體裡還在。
    const reloaded = new PreferencesStore(configPath)
    reloaded.load()
    assert.equal(reloaded.get().agentStatus, false)
  })

  it('agentEvents 跨一次 load() 還原', () => {
    // `agentEvents` 沒有 setter（它的前提「事件回報已關閉」由直接寫檔造出），因此讀入那一半
    // 要以寫檔驗。它與 agentStatus 共用同一份欄位表，這條是那份表的回歸。
    writePreferencesFileAtomic(configPath, {
      version: PREFERENCES_VERSION,
      terminal: { agentEvents: false },
      ui: {},
      updates: {},
    })
    const store = new PreferencesStore(configPath)
    store.load()
    assert.equal(store.get().agentEvents, false)

    // 改字型之後仍在（保留那一半）。
    store.setTerminalFont('Fira Code', 14, null)
    assert.equal(store.get().agentEvents, false, '改字型不該動到事件橋接的開關')
  })

  it('agentView 跨一次 load() 還原 —— 只驗 setter 的回傳值不算', () => {
    // **必須跨 `load()`。** 讀入的白名單是三條路徑之一，而型別檢查曾經對它零感知：
    // 漏在那裡的欄位寫得進磁碟卻讀不回來，而只驗 setter 回傳值的測試照樣全綠。
    // 三條路徑現已自 `PREFERENCE_FIELDS` 推導（漏一個是編譯錯誤），這幾條是那份表的回歸。
    const first = new PreferencesStore(configPath)
    first.load()
    assert.equal(first.get().agentView, undefined, '前置：一開始是未設定')
    first.setAgentView('conversation')

    const second = new PreferencesStore(configPath)
    second.load()
    assert.equal(second.get().agentView, 'conversation')
  })

  it('agentView 只認那兩個字面值，其餘視為未設定', () => {
    for (const bad of ['Conversation', 'chat', '', 42, null, true, {}]) {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ version: PREFERENCES_VERSION, terminal: { agentView: bad } }),
      )
      const store = new PreferencesStore(configPath)
      store.load()
      assert.equal(store.get().agentView, undefined, `不合法的值：${JSON.stringify(bad)}`)
    }
  })

  it('改字型不該動到 agentView', () => {
    const store = new PreferencesStore(configPath)
    store.load()
    store.setAgentView('conversation')

    store.setTerminalFont('Fira Code', 14, null)
    assert.equal(store.get().agentView, 'conversation', '改字型不該把 view 彈回終端')
  })

  it('舊檔（無 agentView）照常解析，其他欄位不受影響', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ version: PREFERENCES_VERSION, terminal: { fontFamily: 'Fira Code', gpuAcceleration: false } }),
    )
    const store = new PreferencesStore(configPath)
    store.load()
    assert.deepEqual(store.get(), { fontFamily: 'Fira Code', gpuAcceleration: false })
  })

  it('GPU 偏好跨重啟還原，且只認真正的布林', () => {
    const first = new PreferencesStore(configPath)
    first.load()
    first.setGpuAcceleration(false)

    const second = new PreferencesStore(configPath)
    second.load()
    assert.equal(second.get().gpuAcceleration, false)

    // 檔案裡的 `"false"`（字串）不是布林 —— 當成未設定（＝預設啟用），
    // 而不是硬轉成 false 把 GPU 關掉。
    fs.writeFileSync(
      configPath,
      JSON.stringify({ version: PREFERENCES_VERSION, terminal: { gpuAcceleration: 'false' } }),
    )
    const third = new PreferencesStore(configPath)
    third.load()
    assert.equal(third.get().gpuAcceleration, undefined, '非布林一律視為未設定')
  })

  it('重啟後還原', () => {
    const first = new PreferencesStore(configPath)
    first.load()
    first.setTerminalFont('Fira Code', 14, null)

    const second = new PreferencesStore(configPath)
    second.load()
    assert.deepEqual(second.get(), { fontFamily: 'Fira Code', fontSize: 14 })
  })

  it('傳 null 清為預設（欄位不占空間）', () => {
    const store = new PreferencesStore(configPath)
    store.load()
    store.setTerminalFont('Fira Code', 14, null)
    store.setTerminalFont(null, null, null)

    assert.deepEqual(store.get(), {})
    assert.deepEqual((readConfig().terminal as Record<string, unknown>), {})
  })

  it('寫入時夾制 size、清理 family', () => {
    const store = new PreferencesStore(configPath)
    store.load()
    const applied = store.setTerminalFont('Bad"Name', 999, null)

    assert.equal(applied.fontSize, 32)
    assert.equal(applied.fontFamily, 'BadName')
  })

  it('不合法的 size 清為未設定，而非寫入原值', () => {
    const store = new PreferencesStore(configPath)
    store.load()
    // 型別上是 number | null，但被入侵的 renderer 可送任意型別 —— 不得原樣持久化
    const applied = store.setTerminalFont('Mono', Number.NaN as unknown as number, null)
    assert.equal(applied.fontSize, undefined)
    assert.equal(applied.fontFamily, 'Mono')
  })

  it('lineHeight 一併設定、夾制並跨重啟還原', () => {
    const first = new PreferencesStore(configPath)
    first.load()
    const applied = first.setTerminalFont('Fira Code', 14, 1.2)
    assert.deepEqual(applied, { fontFamily: 'Fira Code', fontSize: 14, lineHeight: 1.2 })

    // 超出範圍夾制（不是拒絕整筆）
    assert.equal(first.setTerminalFont(null, null, 9).lineHeight, 2)

    first.setTerminalFont('Fira Code', 14, 1.2)
    const second = new PreferencesStore(configPath)
    second.load()
    assert.deepEqual(second.get(), { fontFamily: 'Fira Code', fontSize: 14, lineHeight: 1.2 })
  })

  it('lineHeight 傳 null 清為預設', () => {
    const store = new PreferencesStore(configPath)
    store.load()
    store.setTerminalFont(null, null, 1.5)
    assert.equal(store.get().lineHeight, 1.5)

    store.setTerminalFont(null, null, null)
    assert.equal(store.get().lineHeight, undefined)
  })
})

describe('PreferencesStore：損毀韌性', () => {
  it('內容不是有效 JSON：以預設啟動並保留原檔', () => {
    fs.writeFileSync(configPath, '{ this is not json')

    const store = new PreferencesStore(configPath)
    store.load()

    assert.deepEqual(store.get(), {})
    assert.equal(corruptFiles().length, 1, '原檔須改名保留而非刪除')

    // **隔離之後必須立刻回寫一份預設檔。**
    //
    // 隔離是把原檔**改名**保留，於是那個路徑就不存在了 —— 而「偏好檔不存在」正是首次啟動
    // 語言偵測的判準（見 `ui-localization` 的「首次啟動的語言取自作業系統的偏好語言」）。
    // 少了這次回寫，一個曾經壞過一次偏好檔的使用者會在下一次啟動時莫名其妙換了語言，
    // 而他從來沒有動過語言設定。
    assert.equal(fs.existsSync(configPath), true, '隔離之後必須回寫，否則下次啟動會被當成首次啟動')
    assert.deepEqual(parsePreferences(fs.readFileSync(configPath, 'utf8')), {
      version: PREFERENCES_VERSION,
      terminal: {},
      ui: {},
      updates: {},
    })
    assert.equal(store.existed(), true, '這一次載入不得被視為首次啟動')
  })

  it('版本無法辨識：以預設啟動並保留原檔', () => {
    fs.writeFileSync(configPath, JSON.stringify({ version: 999, terminal: {} }))

    const store = new PreferencesStore(configPath)
    store.load()

    assert.deepEqual(store.get(), {})
    assert.equal(corruptFiles().length, 1)
  })

  it('寫入過程不留下不完整的設定檔', () => {
    fs.writeFileSync(configPath, JSON.stringify({ version: 1, terminal: {} }))
    const before = fs.readFileSync(configPath, 'utf8')

    mock.method(fs, 'renameSync', () => {
      throw new Error('rename failed')
    })

    const store = new PreferencesStore(configPath)
    store.load()
    assert.throws(() => store.setTerminalFont('Mono', 14, null))

    assert.equal(fs.readFileSync(configPath, 'utf8'), before, '目標檔不得被部分寫入')
    assert.equal(fs.existsSync(`${configPath}.tmp`), true, '新內容應落在暫存檔')
  })

  it('writePreferencesFileAtomic 會建立缺少的目錄', () => {
    const nested = path.join(base, 'deep', 'preferences.json')
    writePreferencesFileAtomic(nested, { version: PREFERENCES_VERSION, terminal: {}, ui: {}, updates: {} })
    assert.equal(fs.existsSync(nested), true)
  })
})

describe('agentEvents 讀得回來，且不被字型變更抹掉', () => {
  it('寫得進磁碟也讀得回來', () => {
    const parsed = parsePreferences(
      JSON.stringify({ version: PREFERENCES_VERSION, terminal: { agentEvents: false } }),
    )
    assert.equal(parsed?.terminal.agentEvents, false)
  })

  it('非布林一律視為未設定（＝預設啟用）', () => {
    const parsed = parsePreferences(
      JSON.stringify({ version: PREFERENCES_VERSION, terminal: { agentEvents: 'false' } }),
    )
    assert.equal(parsed?.terminal.agentEvents, undefined)
  })
})

describe('變更字型不抹掉 agentEvents', () => {
  it('setTerminalFont 之後 agentEvents 仍在', () => {
    const file = path.join(tmpdir(), `prefs-agentevents-${process.pid}-${Date.now()}.json`)
    try {
      fs.writeFileSync(
        file,
        JSON.stringify({ version: PREFERENCES_VERSION, terminal: { agentEvents: false } }),
      )
      const store = new PreferencesStore(file)
      store.load()
      assert.equal(store.get().agentEvents, false)

      // **這個方法從空物件重建 `terminal`** —— 每個欄位都倚賴呼叫端記得保留它。
      // 少了那一行，症狀是「關掉事件回報之後調一次字級，它自己開回來了」。
      store.setTerminalFont('Fira Code', 14, null)
      assert.equal(store.get().agentEvents, false)
    } finally {
      fs.rmSync(file, { force: true })
    }
  })
})

describe('projectPreferences：送往 renderer 的逐欄位白名單', () => {
  it('未宣告送往 renderer 的欄位不出現在投影中', () => {
    // `agentEvents` 的 `toRenderer` 是 `false` —— renderer 從不讀它（只有主行程的注入路徑讀）。
    // **這條是白名單真的在做事的證據**：它在主行程的偏好裡，卻不在投影裡。
    const projected = projectPreferences(
      { fontFamily: 'Fira Code', agentStatus: false, agentEvents: false },
      {},
      {},
    )

    assert.equal('agentEvents' in projected, false, 'agentEvents 不該送到 renderer')
    assert.deepEqual(projected, { fontFamily: 'Fira Code', agentStatus: false })
  })

  it('未設定的欄位於投影中省略，而非成為 undefined', () => {
    // **不是風格問題**：`probe:workspace` 有一條以「空偏好的鍵數為 0」為判準的斷言
    // （`scripts/probe-workspace.mjs` 的「損毀的偏好以預設啟動（空偏好）」），
    // 把未設定欄位寫成 `undefined` 會讓它當場變紅。
    assert.equal(Object.keys(projectPreferences({}, {}, {})).length, 0)

    const partial = projectPreferences({ fontSize: 14 }, {}, {})
    assert.deepEqual(Object.keys(partial), ['fontSize'])
  })

  it('投影不是同一個物件 —— 改它不影響主行程持有的偏好', () => {
    const source = { fontFamily: 'Fira Code' }
    const projected = projectPreferences(source, {}, {})
    assert.notEqual(projected, source)
  })
})

describe('UI 偏好：與終端並列的第二個區塊', () => {
  it('不含 ui 區塊的既有偏好檔照常讀入，其餘欄位原封保留', () => {
    // **這是升級路徑。** 本區塊加入之前寫下的檔案沒有 `ui` —— 它必須照常讀入，
    // 且 `PREFERENCES_VERSION` 不得因為多一個區塊而遞增（版本不符會隔離整檔，
    // 等於每個使用者既有的字型設定歸零）。
    fs.writeFileSync(
      configPath,
      JSON.stringify({ version: 1, terminal: { fontFamily: 'Fira Code', gpuAcceleration: false } }),
    )

    const store = new PreferencesStore(configPath)
    store.load()

    assert.equal(store.get().fontFamily, 'Fira Code')
    assert.equal(store.get().gpuAcceleration, false)
    assert.deepEqual(store.ui(), {})
    assert.equal(corruptFiles().length, 0, '缺少 ui 區塊不是損毀')
  })

  it('ui 存在但形狀不對 → 整檔不可信', () => {
    // 缺席與壞掉是兩件事。把後者也當成「沒設定」會讓一份被外部程式改壞的檔案靜默地
    // 以預設繼續，而使用者的**其餘**偏好也一併失效 —— 卻沒有任何人被告知。
    assert.equal(parsePreferences(JSON.stringify({ version: 1, terminal: {}, ui: 5 })), null)
    assert.equal(parsePreferences(JSON.stringify({ version: 1, terminal: {}, ui: null })), null)
  })

  it('不受支援的語言值視為未設定，而不是一個合法的選擇', () => {
    // 「檔案壞了」與「使用者選了英文」不是同一件事 —— 前者回到未設定，讓「未設定＝英文」
    // 那條規則去決定，於是只有一個地方在決定。同 `agentView` 那條白名單。
    for (const bad of ['fr-FR', 'zh', '', 42, null, { language: 'zh-TW' }]) {
      const raw = JSON.stringify({ version: 1, terminal: {}, ui: { language: bad } })
      assert.deepEqual(parsePreferences(raw)?.ui, {}, `不該接受 ${JSON.stringify(bad)}`)
    }

    const good = JSON.stringify({ version: 1, terminal: {}, ui: { language: 'zh-TW' } })
    assert.deepEqual(parsePreferences(good)?.ui, { language: 'zh-TW' })
  })

  it('改語言不影響任何終端偏好', () => {
    const store = new PreferencesStore(configPath)
    store.load()
    store.setTerminalFont('Fira Code', 15, 1.2)
    store.setGpuAcceleration(false)
    store.setAgentStatus(false)

    store.setLanguage('zh-TW')

    assert.deepEqual(store.get(), {
      fontFamily: 'Fira Code',
      fontSize: 15,
      lineHeight: 1.2,
      gpuAcceleration: false,
      agentStatus: false,
    })
    assert.deepEqual(store.ui(), { language: 'zh-TW' })

    // 反向：改字型不得抹掉語言（`setTerminalFont` 自空物件重建 `terminal`）。
    store.setTerminalFont('Monospace', null, null)
    assert.deepEqual(store.ui(), { language: 'zh-TW' })
  })

  it('語言跨重啟保留，null 清為預設', () => {
    const first = new PreferencesStore(configPath)
    first.load()
    first.setLanguage('zh-TW')

    const second = new PreferencesStore(configPath)
    second.load()
    assert.deepEqual(second.ui(), { language: 'zh-TW' })

    second.setLanguage(null)
    const third = new PreferencesStore(configPath)
    third.load()
    assert.deepEqual(third.ui(), {})
  })

  it('語言出現在送往 renderer 的投影中', () => {
    assert.deepEqual(projectPreferences({ fontSize: 14 }, { language: 'zh-TW' }, {}), {
      fontSize: 14,
      language: 'zh-TW',
    })
    // 「未設定即省略」的語意對新區塊同樣適用。
    assert.deepEqual(Object.keys(projectPreferences({}, {}, {})).length, 0)
  })

  it('existed()：偏好檔不存在時為 false，其餘一律為 true', () => {
    // **這是首次啟動偵測的判準，而它不是「語言欄位未設定」的同義詞。**
    const fresh = new PreferencesStore(configPath)
    fresh.load()
    assert.equal(fresh.existed(), false, '真正的首次啟動')

    fresh.setLanguage(null) // 觸發一次寫入
    const second = new PreferencesStore(configPath)
    second.load()
    assert.equal(second.existed(), true, '檔案已存在（即使語言欄位是空的）')
  })
})

describe('automatic hibernation (session-hibernation)', () => {
  it('accepts a non-negative whole number of seconds; anything else is unset (the default)', () => {
    const parse = (value: unknown): number | undefined =>
      parsePreferences(JSON.stringify({ version: 1, terminal: { autoHibernateSeconds: value } }))?.terminal
        .autoHibernateSeconds
    assert.equal(parse(7), 7)
    assert.equal(parse(0), 0, 'zero is off, not unset')
    assert.equal(parse(-1), undefined)
    assert.equal(parse(1.5), undefined)
    assert.equal(parse('86400'), undefined)
  })

  it('off persists as off; null resets to the default (unset)', () => {
    const store = new PreferencesStore(configPath)
    store.load()
    store.setAutoHibernate(0)
    const reloaded = new PreferencesStore(configPath)
    reloaded.load()
    assert.equal(reloaded.get().autoHibernateSeconds, 0)

    reloaded.setAutoHibernate(null)
    assert.equal('autoHibernateSeconds' in reloaded.get(), false)
  })

  it('a change of font keeps it, and it reaches the renderer', () => {
    const store = new PreferencesStore(configPath)
    store.load()
    store.setAutoHibernate(3600)
    store.setTerminalFont(null, 14, null)
    assert.equal(store.get().autoHibernateSeconds, 3600)
    assert.equal(projectPreferences(store.get(), store.ui(), store.updates()).autoHibernateSeconds, 3600)
  })
})

describe('a failed write leaves nothing behind (settings-sections)', () => {
  /** A directory where the atomic write puts its temporary file: `writeFileSync` throws EISDIR. */
  const blockWrites = (): void => fs.mkdirSync(`${configPath}.tmp`)
  const unblockWrites = (): void => fs.rmSync(`${configPath}.tmp`, { recursive: true, force: true })

  it('the setter throws and get() still reports the previous value', () => {
    const store = new PreferencesStore(configPath)
    store.load()
    store.setGpuAcceleration(true)
    blockWrites()
    assert.throws(() => store.setGpuAcceleration(false))
    assert.equal(store.get().gpuAcceleration, true)
  })

  it('a later successful write of another field does not carry the failed value to disk', () => {
    const store = new PreferencesStore(configPath)
    store.load()
    blockWrites()
    assert.throws(() => store.setTerminalFont(null, 20, null))
    unblockWrites()
    store.setAgentStatus(false)
    const terminal = readConfig().terminal as Record<string, unknown>
    assert.equal(terminal.agentStatus, false)
    assert.equal('fontSize' in terminal, false, JSON.stringify(terminal))
  })

  it('a failed language write keeps the language', () => {
    const store = new PreferencesStore(configPath)
    store.load()
    store.setLanguage('zh-TW')
    blockWrites()
    assert.throws(() => store.setLanguage('en'))
    assert.equal(store.ui().language, 'zh-TW')
  })
})

describe('update preferences (app-update)', () => {
  function storeAt(content?: string) {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'spekterm-prefs-updates-'))
    const file = path.join(dir, 'preferences.json')
    if (content !== undefined) fs.writeFileSync(file, content)
    const store = new PreferencesStore(file)
    store.load()
    return { store, file, dir }
  }

  it('is on by default, including in a file written before the block existed', () => {
    assert.equal(storeAt().store.autoUpdateCheck(), true)
    const old = storeAt(JSON.stringify({ version: PREFERENCES_VERSION, terminal: { fontSize: 15 }, ui: {} }))
    assert.equal(old.store.autoUpdateCheck(), true)
    assert.equal(old.store.get().fontSize, 15, 'the other preferences survive')
  })

  it('stores only off, and survives a restart', () => {
    const { store, file } = storeAt()
    store.setAutoUpdateCheck(false)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).updates, { autoUpdateCheck: false })
    const again = new PreferencesStore(file)
    again.load()
    assert.equal(again.autoUpdateCheck(), false)
    again.setAutoUpdateCheck(null)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).updates, {})
  })

  it('falls back to on for a junk value, and quarantines a malformed block', () => {
    const junk = storeAt(JSON.stringify({ version: PREFERENCES_VERSION, terminal: {}, ui: {}, updates: { autoUpdateCheck: 'no' } }))
    assert.equal(junk.store.autoUpdateCheck(), true)
    const malformed = storeAt(JSON.stringify({ version: PREFERENCES_VERSION, terminal: { fontSize: 15 }, ui: {}, updates: 'off' }))
    assert.equal(malformed.store.get().fontSize, undefined, 'the whole file is untrusted')
    assert.ok(fs.readdirSync(malformed.dir).some((name) => name.includes('.corrupt-')))
  })

  it('is projected to the renderer, and changing it keeps the terminal preferences', () => {
    const { store } = storeAt()
    store.setGpuAcceleration(false)
    const projected = projectPreferences(store.get(), store.ui(), store.setAutoUpdateCheck(false))
    assert.equal(projected.autoUpdateCheck, false)
    assert.equal(projected.gpuAcceleration, false)
  })
})

describe('theme and zoom (ui-appearance)', () => {
  it('a file written before them reads as System and 100%, every other preference unchanged', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ version: PREFERENCES_VERSION, terminal: { fontSize: 15 }, ui: { language: 'zh-TW' } }),
    )
    const store = new PreferencesStore(configPath)
    store.load()
    assert.equal(store.ui().theme, undefined)
    assert.equal(store.zoom(), 100)
    assert.equal(store.get().fontSize, 15)
    assert.equal(store.ui().language, 'zh-TW')
  })

  it('an unknown theme reads as System and the file is not quarantined', () => {
    // Control: quarantining on an unknown value (returning null from `parsePreferences`) turns both red.
    fs.writeFileSync(
      configPath,
      JSON.stringify({ version: PREFERENCES_VERSION, terminal: { fontSize: 15 }, ui: { theme: 'sepia' } }),
    )
    const store = new PreferencesStore(configPath)
    store.load()
    assert.equal(store.ui().theme, undefined)
    assert.equal(store.get().fontSize, 15)
    assert.equal(corruptFiles().length, 0)
  })

  it('an off-step zoom snaps to the nearest step, the smaller on a tie; a non-number is unset', () => {
    const zoomOf = (value: unknown): number | undefined =>
      parsePreferences(JSON.stringify({ version: PREFERENCES_VERSION, terminal: {}, ui: { zoom: value } }))?.ui.zoom
    assert.equal(zoomOf(126), 125)
    assert.equal(zoomOf(105), 100)
    assert.equal(zoomOf(999), 175)
    assert.equal(zoomOf('150'), undefined)
  })

  it('theme and zoom survive a restart; null resets them by removing the field', () => {
    const first = new PreferencesStore(configPath)
    first.load()
    first.setTheme('dark')
    first.setZoom(125)
    const second = new PreferencesStore(configPath)
    second.load()
    assert.deepEqual(second.ui(), { theme: 'dark', zoom: 125 })
    second.setTheme(null)
    second.setZoom(null)
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).ui, {})
  })

  it('stepping zooms one step from the zoom in effect and stops at the ends', () => {
    const store = new PreferencesStore(configPath)
    store.load()
    assert.equal(store.stepZoom(1).zoom, 110)
    store.setZoom(175)
    assert.equal(store.stepZoom(1).zoom, 175)
    assert.equal(store.stepZoom(0).zoom, undefined, 'reset stores the default by removing it')
    assert.equal(store.zoom(), 100)
  })

  it('both reach the renderer, and changing them keeps the language and the terminal preferences', () => {
    const store = new PreferencesStore(configPath)
    store.load()
    store.setLanguage('zh-TW')
    store.setTerminalFont('Fira Code', 15, null)
    store.setTheme('light')
    const projected = projectPreferences(store.get(), store.setZoom(150), store.updates())
    assert.equal(projected.theme, 'light')
    assert.equal(projected.zoom, 150)
    assert.equal(projected.language, 'zh-TW')
    assert.equal(projected.fontFamily, 'Fira Code')
  })
})
