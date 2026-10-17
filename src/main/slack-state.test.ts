import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { SecretStore } from './secret-store'
import { SLACK_TOKEN_KINDS, type SlackState, isTokenKind, secretName, slackState, slackWrite } from './slack-state'
import type { SlackStatus } from './slack-service'
import { DEFAULT_API_BASE_URL, DEFAULT_LOOKBACK_DAYS, InvalidEndpointError, SlackSettingsStore } from './slack-settings-store'

/** 一份不失效、什麼都沒交付的狀態 —— 本檔案驗的是投影，不是狀態本身。 */
const idleStatus = (): SlackStatus => ({
  configured: true,
  delivered: 0,
  deferred: 0,
  realtime: 'off',
})

/** 獨特到不會被任何東西吞掉。**「不含憑證」的斷言要釘得住才有意義。** */
const APP_SENTINEL = 'xapp-SENTINEL-4d2b8e01-do-not-leak'
const USER_SENTINEL = 'xoxp-SENTINEL-a7f3c91e-do-not-leak'

let base: string
let secrets: SecretStore
let settings: SlackSettingsStore

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'spek-slack-state-')))
  secrets = new SecretStore(path.join(base, 'secrets.json'))
  secrets.load()
  settings = new SlackSettingsStore(path.join(base, 'slack.json'))
  settings.load()
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('slackState：送往 renderer 的狀態', () => {
  it('**整份序列化之後不含任何憑證的片段**', () => {
    // **這是本組最重要的一條斷言，而它的層級是刻意選的。**
    // probe 在畫面上斷言「看不到憑證」是不夠的 —— 憑證可以在 IPC payload 裡而畫面上不顯示，
    // 那時畫面斷言全綠而憑證已經到了 renderer（那裡渲染的是不受信任的內容）。
    // 因此斷言的對象是**整份回傳值的序列化結果**，不是 DOM。
    secrets.set(secretName('appToken'), APP_SENTINEL)
    secrets.set(secretName('userToken'), USER_SENTINEL)
    settings.rememberIdentity('T012ABCDEF', 'U345GHIJKL')

    const state = slackState({ settings, secrets, status: idleStatus })
    const serialized = JSON.stringify(state)

    assert.equal(serialized.includes(APP_SENTINEL), false, 'app token 洩漏到 renderer')
    assert.equal(serialized.includes(USER_SENTINEL), false, 'user token 洩漏到 renderer')
    // 連片段都不行 —— 前綴與末幾碼同樣是片段。
    assert.equal(serialized.includes(USER_SENTINEL.slice(0, 12)), false, '洩漏了憑證的前綴')
    assert.equal(serialized.includes(USER_SENTINEL.slice(-12)), false, '洩漏了憑證的末段')

    // **前提：這個狀態確實反映了「已設定」** —— 否則上面四條對一個什麼都不回的實作照樣全綠。
    assert.deepEqual(state.configured, { appToken: true, userToken: true })
  })

  it('憑證未設定時 configured 為假，且身分欄位不存在', () => {
    const state = slackState({ settings, secrets, status: idleStatus })
    assert.deepEqual(state.configured, { appToken: false, userToken: false })
    assert.equal('teamId' in state.settings, false, '未設定的欄位應省略而非為 undefined')
    assert.equal('selfUserId' in state.settings, false)
  })

  it('推導出的身分出現在投影中 —— 介面要顯示它，而它不是使用者填的', () => {
    settings.rememberIdentity('T012ABCDEF', 'U345GHIJKL')
    const state = slackState({ settings, secrets, status: idleStatus })
    assert.equal(state.settings.teamId, 'T012ABCDEF')
    assert.equal(state.settings.selfUserId, 'U345GHIJKL')
  })

  it('effective 帶著套用預設後的值 —— 預設住在主行程', () => {
    const state = slackState({ settings, secrets, status: idleStatus })
    assert.equal(state.effective.apiBaseUrl, DEFAULT_API_BASE_URL)
    assert.equal(state.effective.lookbackDays, DEFAULT_LOOKBACK_DAYS)
    assert.equal(state.usesDefaultEndpoint, true)
  })

  it('端點非預設值時 usesDefaultEndpoint 為假 —— 介面據此警示', () => {
    // `secret-scope` 的端點第二條：憑證的目的地是一個資料欄位，那個代價只有在使用者看得見時
    // 才可接受。**一個沉默的端點欄位比沒有這個欄位更糟。**
    settings.setApiBaseUrl('https://slack.internal.example.com/api')
    const state = slackState({ settings, secrets, status: idleStatus })
    assert.equal(state.usesDefaultEndpoint, false)
    assert.equal(state.effective.apiBaseUrl, 'https://slack.internal.example.com/api')
  })

  it('狀態中沒有任何檔案系統位置', () => {
    // renderer 的詞彙裡沒有絕對路徑。機密檔與設定檔的位置都不該經這裡流出去。
    secrets.set(secretName('userToken'), USER_SENTINEL)
    const serialized = JSON.stringify(slackState({ settings, secrets, status: idleStatus }))
    assert.equal(serialized.includes(base), false, '洩漏了落盤位置')
    assert.equal(serialized.includes('secrets.json'), false)
  })
})

describe('憑證種類的白名單', () => {
  it('只認那兩個字面值', () => {
    for (const good of SLACK_TOKEN_KINDS) assert.equal(isTokenKind(good), true)
    for (const bad of ['botToken', 'APPTOKEN', '', null, 42, {}, ['appToken']]) {
      assert.equal(isTokenKind(bad), false, `不該被接受：${String(bad)}`)
    }
  })

  it('機密檔的鍵由種類推導，且通過機密模組的名稱白名單', () => {
    // 名稱不合法時 `SecretStore.set()` 會靜默不寫 —— 那會讓「設定了卻沒生效」變成一個
    // 靜默失效。這條釘住兩邊的字元集是相容的。
    for (const kind of SLACK_TOKEN_KINDS) {
      secrets.set(secretName(kind), USER_SENTINEL)
      assert.equal(secrets.has(secretName(kind)), true, `${kind} 的鍵被機密模組拒絕了`)
    }
  })
})

describe('slackWrite (settings-sections)', () => {
  const STATE = { configured: false } as unknown as SlackState

  it('answers the state after a write that succeeds', () => {
    assert.deepEqual(slackWrite(() => {}, () => STATE), { ok: true, state: STATE })
  })

  it('tells a refused endpoint apart from a failed write', () => {
    assert.deepEqual(
      slackWrite(() => {
        throw new InvalidEndpointError()
      }, () => STATE),
      { ok: false, code: 'INVALID_ENDPOINT' },
    )
    const quiet = mock.method(console, 'error', () => {})
    assert.deepEqual(
      slackWrite(() => {
        throw Object.assign(new Error('EISDIR: /home/me/.config/Spekterm/slack.json.tmp'), { code: 'EISDIR' })
      }, () => STATE),
      { ok: false, code: 'WRITE_FAILED' },
    )
    quiet.mock.restore()
  })

  it('a failed write sends no text to the renderer, only the code', () => {
    const quiet = mock.method(console, 'error', () => {})
    const result = slackWrite(() => {
      throw new Error('/home/me/.config/Spekterm/slack.json.tmp')
    }, () => STATE)
    quiet.mock.restore()
    assert.equal(JSON.stringify(result).includes('/home/me'), false)
  })
})
