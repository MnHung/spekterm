import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_LOOKBACK_DAYS,
  InvalidEndpointError,
  SLACK_SETTINGS_VERSION,
  SlackSettingsStore,
  parseSlackSettings,
  projectSlackSettings,
  sanitizeApiBaseUrl,
  writeSlackSettingsFileAtomic,
} from './slack-settings-store'

let base: string
let settingsPath: string

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'spek-slack-')))
  settingsPath = path.join(base, 'slack.json')
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('端點：scheme 白名單', () => {
  it('只認 https', () => {
    assert.equal(sanitizeApiBaseUrl('https://slack.example.com/api'), 'https://slack.example.com/api')
    for (const bad of [
      'http://slack.com/api',
      'file:///etc/passwd',
      'data:text/plain,x',
      'javascript:alert(1)',
      'ftp://example.com',
      'slack.com/api',
      '',
      42,
      null,
      {},
    ]) {
      assert.equal(sanitizeApiBaseUrl(bad), undefined, `不該被接受：${String(bad)}`)
    }
  })

  it('尾斜線正規化 —— 同一個端點不該在介面上呈現為兩個值', () => {
    assert.equal(sanitizeApiBaseUrl('https://slack.com/api/'), 'https://slack.com/api')
    assert.equal(sanitizeApiBaseUrl('https://slack.com/api///'), 'https://slack.com/api')
  })
})

describe('SlackSettingsStore：預設與明確設定', () => {
  it('未設定時回看範圍與端點都是預設值，且 usesDefaultEndpoint 為真', () => {
    const store = new SlackSettingsStore(settingsPath)
    store.load()

    assert.equal(store.lookbackDays(), DEFAULT_LOOKBACK_DAYS)
    assert.equal(store.apiBaseUrl(), DEFAULT_API_BASE_URL)
    assert.equal(store.usesDefaultEndpoint(), true)
    assert.deepEqual(store.get(), {}, '未設定的欄位不占空間')
  })

  it('設定端點之後 usesDefaultEndpoint 為假 —— 介面據此標示', () => {
    // **這是「非預設值時對使用者可見」那條 requirement 的載體的一半**（另一半在 probe）。
    // 憑證的目的地是一個資料欄位，那個代價只有在使用者看得見時才可接受。
    const store = new SlackSettingsStore(settingsPath)
    store.load()
    store.setApiBaseUrl('https://slack.internal.example.com/api')

    assert.equal(store.usesDefaultEndpoint(), false)
    assert.equal(store.apiBaseUrl(), 'https://slack.internal.example.com/api')
  })

  it('an invalid endpoint is refused, and the stored one stays (settings-sections)', () => {
    // It used to clear to the default: a typo erased the user's custom endpoint and said nothing.
    const store = new SlackSettingsStore(settingsPath)
    store.load()
    store.setApiBaseUrl('https://ok.example.com/api')
    assert.throws(() => store.setApiBaseUrl('http://downgrade.example.com/api'), InvalidEndpointError)

    assert.equal(store.apiBaseUrl(), 'https://ok.example.com/api', 'the downgraded scheme leaves no value')
    const reloaded = new SlackSettingsStore(settingsPath)
    reloaded.load()
    assert.equal(reloaded.apiBaseUrl(), 'https://ok.example.com/api')
  })

  it('a stored invalid endpoint still loads as the default', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ version: SLACK_SETTINGS_VERSION, slack: { apiBaseUrl: 'http://downgrade.example.com/api' } }))
    const store = new SlackSettingsStore(settingsPath)
    store.load()
    assert.equal(store.apiBaseUrl(), DEFAULT_API_BASE_URL)
  })

  it('a failed write leaves the settings as they were', () => {
    const store = new SlackSettingsStore(settingsPath)
    store.load()
    store.setLookbackDays(7)
    fs.mkdirSync(`${settingsPath}.tmp`)
    assert.throws(() => store.setLookbackDays(14))
    assert.throws(() => store.setApiBaseUrl('https://other.example.com/api'))
    assert.equal(store.lookbackDays(), 7)
    assert.equal(store.usesDefaultEndpoint(), true)
  })

  it('回看範圍被夾制於合理區間', () => {
    const store = new SlackSettingsStore(settingsPath)
    store.load()

    store.setLookbackDays(999)
    assert.equal(store.lookbackDays(), 30)
    store.setLookbackDays(0)
    assert.equal(store.lookbackDays(), 1)
    store.setLookbackDays(null)
    assert.equal(store.lookbackDays(), DEFAULT_LOOKBACK_DAYS, 'null ＝清回預設')
  })

  it('設定跨一次 load() 還原', () => {
    const first = new SlackSettingsStore(settingsPath)
    first.load()
    first.setLookbackDays(14)
    first.setApiBaseUrl('https://slack.internal.example.com/api')

    const second = new SlackSettingsStore(settingsPath)
    second.load()
    assert.equal(second.lookbackDays(), 14)
    assert.equal(second.apiBaseUrl(), 'https://slack.internal.example.com/api')
  })

  it('改一個欄位不抹掉另一個', () => {
    // 與 `setTerminalFont` 抹掉 `agentStatus` 同一族的缺陷 —— 這裡的 setter 自當前值展開，
    // 所以表達不出來；這條是那個性質的回歸。
    const store = new SlackSettingsStore(settingsPath)
    store.load()
    store.setLookbackDays(14)
    store.setApiBaseUrl('https://slack.internal.example.com/api')
    assert.equal(store.lookbackDays(), 14, '設端點不該動到回看範圍')

    store.setLookbackDays(3)
    assert.equal(
      store.apiBaseUrl(),
      'https://slack.internal.example.com/api',
      '設回看範圍不該動到端點',
    )
  })
})

describe('身分：自憑證推導的快取，不是使用者設定', () => {
  it('rememberIdentity 落盤並跨 load() 還原', () => {
    const first = new SlackSettingsStore(settingsPath)
    first.load()
    first.rememberIdentity('T012ABCDEF', 'U345GHIJKL')

    const second = new SlackSettingsStore(settingsPath)
    second.load()
    assert.equal(second.get().teamId, 'T012ABCDEF')
    assert.equal(second.get().selfUserId, 'U345GHIJKL')
  })

  it('形狀不合的識別碼被清掉，而非寫入垃圾', () => {
    const store = new SlackSettingsStore(settingsPath)
    store.load()
    store.rememberIdentity('T012ABCDEF', 'U345GHIJKL')
    store.rememberIdentity('not a team', 'U345GHIJKL')

    assert.equal(store.get().teamId, undefined, '不合法的 team 應被清掉')
    assert.equal(store.get().selfUserId, 'U345GHIJKL', '另一個不受影響')
  })

  it('記下身分不抹掉使用者的設定', () => {
    const store = new SlackSettingsStore(settingsPath)
    store.load()
    store.setLookbackDays(14)
    store.rememberIdentity('T012ABCDEF', 'U345GHIJKL')

    assert.equal(store.lookbackDays(), 14)
  })
})

describe('parseSlackSettings：結構嚴格、個別欄位寬容', () => {
  it('版本不符或 slack 不是物件 → null', () => {
    assert.equal(parseSlackSettings(JSON.stringify({ version: 999, slack: {} })), null)
    assert.equal(parseSlackSettings(JSON.stringify({ version: SLACK_SETTINGS_VERSION, slack: 1 })), null)
    assert.equal(parseSlackSettings('{ not json'), null)
  })

  it('形狀不合的單一欄位被忽略，其餘欄位照常生效', () => {
    // **不因一個壞欄位丟棄整份** —— 否則一個壞掉的端點會讓使用者連「我連到哪個工作區」
    // 都看不到，而那正是他要用來判斷「是不是連線壞了」的資訊。
    const parsed = parseSlackSettings(
      JSON.stringify({
        version: SLACK_SETTINGS_VERSION,
        slack: {
          teamId: 'T012ABCDEF',
          selfUserId: 'lowercase-not-a-slack-id',
          lookbackDays: 'seven',
          apiBaseUrl: 'http://downgrade.example.com',
        },
      }),
    )
    assert.deepEqual(parsed?.slack, { teamId: 'T012ABCDEF' })
  })

  it('無法信任的檔案被改名保留，並以預設啟動', () => {
    fs.writeFileSync(settingsPath, '{ not json')
    const store = new SlackSettingsStore(settingsPath)
    store.load()

    assert.deepEqual(store.get(), {})
    const kept = fs.readdirSync(base).filter((name) => name.includes('slack.json.corrupt-'))
    assert.equal(kept.length, 1)
  })
})

describe('projectSlackSettings：逐欄位白名單', () => {
  it('未設定的欄位於投影中省略，而非成為 undefined', () => {
    assert.equal(Object.keys(projectSlackSettings({})).length, 0)
    assert.deepEqual(Object.keys(projectSlackSettings({ lookbackDays: 7 })), ['lookbackDays'])
  })

  it('投影只含宣告要送出的欄位', () => {
    // 目前四個欄位都送（介面都要顯示它們）。**憑證不在這個物件裡** —— 這條的價值在
    // mutation：把一個機密欄位加進 SLACK_FIELDS 並宣告 toRenderer，它必須變紅。
    const projected = projectSlackSettings({
      teamId: 'T012ABCDEF',
      selfUserId: 'U345GHIJKL',
      lookbackDays: 14,
      apiBaseUrl: 'https://slack.internal.example.com/api',
    })
    assert.deepEqual(Object.keys(projected).sort(), [
      'apiBaseUrl',
      'lookbackDays',
      'selfUserId',
      'teamId',
    ])
  })

  it('投影不是同一個物件', () => {
    const source = { lookbackDays: 7 }
    assert.notEqual(projectSlackSettings(source), source)
  })
})

describe('落盤檔的形狀', () => {
  it('帶版本欄位，且內容只有 slack 一個區塊', () => {
    writeSlackSettingsFileAtomic(settingsPath, {
      version: SLACK_SETTINGS_VERSION,
      slack: { lookbackDays: 7 },
    })
    const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    assert.equal(onDisk.version, SLACK_SETTINGS_VERSION)
    assert.deepEqual(Object.keys(onDisk).sort(), ['slack', 'version'])
  })
})
