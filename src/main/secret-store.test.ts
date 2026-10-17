import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import {
  SECRETS_VERSION,
  Secret,
  SecretStore,
  parseSecrets,
  writeSecretsFileAtomic,
} from './secret-store'

/** 一個獨特到不會被任何東西吞掉的值 —— 「不含機密」的斷言要釘得住才有意義。 */
const SENTINEL = 'xoxp-SENTINEL-a7f3c91e-do-not-leak'

let base: string
let secretsPath: string

/** 九個權限位元。 */
function mode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'spek-secrets-')))
  secretsPath = path.join(base, 'secrets.json')
})

afterEach(() => {
  mock.restoreAll()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('Secret：字串化不吐內容', () => {
  it('toString / 樣板字串 / String() 都吐 redacted', () => {
    const secret = new Secret(SENTINEL)
    assert.equal(secret.toString().includes(SENTINEL), false)
    assert.equal(`${secret}`.includes(SENTINEL), false)
    assert.equal(String(secret).includes(SENTINEL), false)
  })

  it('JSON.stringify 不吐內容 —— 含把它包在設定物件裡整份序列化', () => {
    const secret = new Secret(SENTINEL)
    assert.equal(JSON.stringify(secret).includes(SENTINEL), false)
    assert.equal(JSON.stringify({ slack: { token: secret } }).includes(SENTINEL), false)
  })

  it('util.inspect 吐出可讀的 redaction 標記，而非一個空物件', () => {
    // **這條刻意不只斷言「不含 SENTINEL」。** `#value` 是真正的 private field，`util.inspect`
    // 本來就看不見它（會吐 `Secret {}`）—— 所以「不含 SENTINEL」對**沒有** inspect.custom 的
    // 實作一樣成立，那條斷言零鑑別力（實測：拿掉覆寫，它照樣綠）。
    //
    // inspect.custom 真正提供的是**可讀性**：讀 log 的人要知道那裡有一份機密被略過，
    // 而不是以為那個欄位沒有值。因此斷言標記本身。
    const secret = new Secret(SENTINEL)
    assert.equal(inspect(secret).includes(SENTINEL), false, '前提：不含明文')
    assert.match(inspect(secret), /redacted/, 'inspect 應吐出 redaction 標記')
    assert.match(inspect({ token: secret }, { depth: 5 }), /redacted/)
  })

  it('reveal() 是唯一取得內容的入口', () => {
    assert.equal(new Secret(SENTINEL).reveal(), SENTINEL)
  })
})

describe('SecretStore：權限是「持有」而不是「建立時設定」', () => {
  it('新建的檔案僅擁有者可讀寫', () => {
    const store = new SecretStore(secretsPath)
    store.load()
    store.set('slack.userToken', SENTINEL)

    assert.equal(mode(secretsPath), 0o600, `實際權限：${mode(secretsPath).toString(8)}`)
  })

  it('目標檔已存在且權限較寬時，寫入之後權限被收緊', () => {
    // **`fs.writeFileSync` 的 `mode` 只在建立時生效** —— 對一個已存在的 0644 檔案完全無效。
    // 處置是一律「暫存檔 → 更名」，`rename` 以暫存檔的 inode（連同權限）取代目標。
    //
    // **不可先 load() 再把檔案改寬** —— 第一版就是那樣寫的，於是 `load()` 的收緊搶先把它變成
    // 0600，這條測試靠那個通過，而「改成直接 writeFileSync（不走暫存檔）」的對照組**不會變紅**。
    // 寬檔案必須在寫入路徑之前、且在 load() 之後才出現。
    const store = new SecretStore(secretsPath)
    store.load()

    fs.writeFileSync(secretsPath, '{}')
    fs.chmodSync(secretsPath, 0o644)
    assert.equal(mode(secretsPath), 0o644, '前置：目標檔確實是較寬的權限')

    store.set('slack.userToken', SENTINEL)

    assert.equal(mode(secretsPath), 0o600, `實際權限：${mode(secretsPath).toString(8)}`)
  })

  it('暫存檔已存在且權限較寬時，其權限不會被 rename 帶到目標檔上', () => {
    // **這是暫存檔那道明確 `chmod` 唯一的鑑別力來源。** 前一次寫入中途崩潰會留下一個暫存檔；
    // 那時 `writeFileSync` 的 `mode` 對它完全無效，而 `rename` 會把它的權限帶到目標檔上。
    // （它**不是**防 umask 的 —— umask 只清位元，`mode: 0o600` 不可能因此變寬。）
    fs.writeFileSync(`${secretsPath}.tmp`, 'leftover')
    fs.chmodSync(`${secretsPath}.tmp`, 0o666)

    writeSecretsFileAtomic(secretsPath, {
      version: SECRETS_VERSION,
      secrets: { 'slack.userToken': SENTINEL },
    })

    assert.equal(mode(secretsPath), 0o600, `實際權限：${mode(secretsPath).toString(8)}`)
  })

  it('load() 也收緊 —— 檔案可能在兩次執行之間被外部改寬', () => {
    writeSecretsFileAtomic(secretsPath, {
      version: SECRETS_VERSION,
      secrets: { 'slack.userToken': SENTINEL },
    })
    fs.chmodSync(secretsPath, 0o666)
    assert.equal(mode(secretsPath), 0o666, '前置：被外部改寬了')

    new SecretStore(secretsPath).load()

    assert.equal(mode(secretsPath), 0o600, `實際權限：${mode(secretsPath).toString(8)}`)
  })

  it('更名前的暫存檔也僅擁有者可讀寫', () => {
    // 暫存檔在被更名之前是一個真實存在的檔案 —— 權限寬就有一個全域可讀的窗口。
    // 以 `rename` 的 spy 在「暫存檔還在」的那一刻量它。
    const seen: number[] = []
    const realRename = fs.renameSync
    mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      seen.push(mode(String(from)))
      return realRename(from, to)
    })

    writeSecretsFileAtomic(secretsPath, {
      version: SECRETS_VERSION,
      secrets: { 'slack.userToken': SENTINEL },
    })

    assert.deepEqual(seen, [0o600], `暫存檔在更名前的權限：${seen.map((m) => m.toString(8)).join()}`)
  })
})

describe('SecretStore：讀寫與衍生事實', () => {
  it('設定後跨一次 load() 還原', () => {
    const first = new SecretStore(secretsPath)
    first.load()
    assert.equal(first.has('slack.userToken'), false, '前置：一開始什麼都沒有')
    first.set('slack.userToken', SENTINEL)

    const second = new SecretStore(secretsPath)
    second.load()
    assert.equal(second.get('slack.userToken')?.reveal(), SENTINEL)
  })

  it('has() 與 names() 是可以送給 renderer 的衍生事實，且不含內容', () => {
    const store = new SecretStore(secretsPath)
    store.load()
    store.set('slack.userToken', SENTINEL)
    store.set('slack.appToken', 'xapp-another')

    assert.equal(store.has('slack.userToken'), true)
    assert.deepEqual(store.names(), ['slack.appToken', 'slack.userToken'])
    assert.equal(JSON.stringify(store.names()).includes(SENTINEL), false)
  })

  it('清除與設為空字串都使該項不存在，其餘不受影響', () => {
    const store = new SecretStore(secretsPath)
    store.load()
    store.set('slack.userToken', SENTINEL)
    store.set('slack.appToken', 'xapp-another')

    store.clear('slack.userToken')
    assert.equal(store.has('slack.userToken'), false)
    assert.equal(store.has('slack.appToken'), true, '清一個不該動到另一個')

    store.set('slack.appToken', '')
    assert.equal(store.has('slack.appToken'), false, '空字串＝清除')
  })

  it('名稱不合法時不寫入', () => {
    const store = new SecretStore(secretsPath)
    store.load()
    for (const bad of ['', '../escape', 'has space', 'has/slash', '1leading-digit']) {
      store.set(bad, SENTINEL)
      assert.equal(store.has(bad), false, `不合法的名稱被接受了：${bad}`)
    }
  })
})

describe('parseSecrets：結構嚴格、個別項目寬容', () => {
  it('版本不符或 secrets 不是物件 → null（整檔不可信）', () => {
    assert.equal(parseSecrets(JSON.stringify({ version: 999, secrets: {} })), null)
    assert.equal(parseSecrets(JSON.stringify({ version: SECRETS_VERSION, secrets: 42 })), null)
    assert.equal(parseSecrets('{ not json'), null)
  })

  it('單一壞項被忽略，其餘憑證照常生效', () => {
    // **不因一個壞值丟棄整份** —— 那會讓使用者莫名地要把所有服務重新設定一次。
    const parsed = parseSecrets(
      JSON.stringify({
        version: SECRETS_VERSION,
        secrets: { 'slack.userToken': SENTINEL, 'bad name': 'x', 'slack.appToken': 42 },
      }),
    )
    assert.deepEqual(parsed?.secrets, { 'slack.userToken': SENTINEL })
  })

  it('無法信任的檔案被改名保留而非刪除，且以「什麼都沒設定」啟動', () => {
    fs.writeFileSync(secretsPath, '{ not json', { mode: 0o600 })
    const store = new SecretStore(secretsPath)
    store.load()

    assert.deepEqual(store.names(), [])
    const kept = fs.readdirSync(base).filter((name) => name.includes('secrets.json.corrupt-'))
    assert.equal(kept.length, 1, '原檔應改名保留')
  })
})

describe('a failed write leaves the secrets as they were (settings-sections)', () => {
  it('set and clear throw, and the previous value is still the one in use', () => {
    const store = new SecretStore(secretsPath)
    store.load()
    store.set('slack.userToken', 'xoxp-old')
    fs.mkdirSync(`${secretsPath}.tmp`)
    assert.throws(() => store.set('slack.userToken', 'xoxp-half'))
    assert.equal(store.get('slack.userToken')?.reveal(), 'xoxp-old')
    assert.throws(() => store.clear('slack.userToken'))
    assert.equal(store.get('slack.userToken')?.reveal(), 'xoxp-old')
  })
})
