import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import {
  ROUTING_VERSION,
  RoutingStore,
  isAuthoredCriterion,
  parseRoutingFile,
  resolveRouting,
  type RoutingConfig,
  type RoutingRule,
} from './intake-routing'
import type { Intake } from './intake-schema'

const bases: string[] = []
after(() => {
  for (const base of bases) fs.rmSync(base, { recursive: true, force: true })
})

const FOLDERS = new Set(['f1', 'f2', 'f3'])

function intake(overrides: Partial<Intake['authored']> = {}, originId = 'C1'): Intake {
  return {
    id: 'a1',
    verified: { adapter: 'file', originKind: 'slack', originId },
    authored: { title: 'alpha beta', body: 'body', actor: 'actor', originLabel: '#dev', ...overrides },
    receivedAt: 0,
  }
}

function rule(id: string, criterion: RoutingRule['criterion'], contains: string, folderId: string): RoutingRule {
  return { id, criterion, contains, folderId }
}

describe('有序規則，第一個命中者勝出', () => {
  // **三條規則、三個 folder。** 兩條的話，「第一個命中勝出」與 last-match-wins
  // 在對調之後的結果剛好都會改變，兩種相反語意分不開。
  const rules = [
    rule('r1', 'title', 'zzz', 'f1'),
    rule('r2', 'title', 'alpha', 'f2'),
    rule('r3', 'title', 'beta', 'f3'),
  ]

  it('同時符合第二與第三條時取第二 —— 斷言絕對的 folder', () => {
    const result = resolveRouting({ rules, fallbackFolderId: 'f1' }, intake(), FOLDERS)
    assert.deepEqual(result, { ok: true, folderId: 'f2' })
  })

  it('把第二條移到第三條之後，結果變成第三條原本指向的那個', () => {
    const reordered = [rules[0], rules[2], rules[1]]
    const result = resolveRouting({ rules: reordered, fallbackFolderId: 'f1' }, intake(), FOLDERS)
    assert.deepEqual(result, { ok: true, folderId: 'f3' })
  })

  it('依來源座標識別碼解析 —— 標題不符、座標符合', () => {
    const byOrigin = [rule('r1', 'originId', 'C9', 'f3')]
    const result = resolveRouting({ rules: byOrigin, fallbackFolderId: null }, intake({}, 'C9'), FOLDERS)
    assert.deepEqual(result, { ok: true, folderId: 'f3' })
  })
})

describe('判準的分類', () => {
  it('第三方撰寫的欄位被標示為可操縱', () => {
    assert.equal(isAuthoredCriterion('title'), true)
    assert.equal(isAuthoredCriterion('body'), true)
    assert.equal(isAuthoredCriterion('actor'), true)
    assert.equal(isAuthoredCriterion('originLabel'), true)
  })

  it('接收端可驗證的欄位不被標示', () => {
    assert.equal(isAuthoredCriterion('originKind'), false)
    assert.equal(isAuthoredCriterion('originId'), false)
  })
})

describe('fallback', () => {
  it('有一條存在但不命中的規則時採用 fallback', () => {
    // fixture 必須**有一條規則且它不命中** —— 規則清單為空的話，
    // 「規則被走過但都沒命中」這條路徑零覆蓋。
    const config: RoutingConfig = { rules: [rule('r1', 'title', 'nope', 'f1')], fallbackFolderId: 'f2' }
    assert.deepEqual(resolveRouting(config, intake(), FOLDERS), { ok: true, folderId: 'f2' })
  })

  it('一條規則都沒有時採用 fallback', () => {
    const config: RoutingConfig = { rules: [], fallbackFolderId: 'f2' }
    assert.deepEqual(resolveRouting(config, intake(), FOLDERS), { ok: true, folderId: 'f2' })
  })
})

describe('解析不出時拒絕，不靜默退回', () => {
  it('無規則亦無 fallback 時拒絕', () => {
    const result = resolveRouting({ rules: [], fallbackFolderId: null }, intake(), FOLDERS)
    assert.deepEqual(result, { ok: false, reason: 'NO_MATCH' })
  })

  it('命中的 folder 已移出 workspace 時拒絕 —— **即使 fallback 可用**', () => {
    // fixture 必須同時設有可用的 fallback。少了它，「視為未命中往下走」的錯誤實作
    // 也會得到「拒絕」（往下走之後同樣無處可去），這條就沒有鑑別力。
    const config: RoutingConfig = { rules: [rule('r1', 'title', 'alpha', 'gone')], fallbackFolderId: 'f2' }
    const result = resolveRouting(config, intake(), FOLDERS)
    assert.deepEqual(result, { ok: false, reason: 'FOLDER_GONE', folderId: 'gone' })
  })

  it('兩種拒絕的原因可區分', () => {
    const noMatch = resolveRouting({ rules: [], fallbackFolderId: null }, intake(), FOLDERS)
    const gone = resolveRouting(
      { rules: [rule('r1', 'title', 'alpha', 'gone')], fallbackFolderId: 'f2' },
      intake(),
      FOLDERS,
    )
    assert.notEqual(noMatch.ok ? '' : noMatch.reason, gone.ok ? '' : gone.reason)
  })

  it('fallback 指向已移出的 folder 時也拒絕', () => {
    const result = resolveRouting({ rules: [], fallbackFolderId: 'gone' }, intake(), FOLDERS)
    assert.equal(result.ok, false)
  })
})

describe('規則落在本能力自己的檔案', () => {
  function tempStore(): { store: RoutingStore; file: string } {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-routing-'))
    bases.push(base)
    const file = path.join(base, 'intake-routing.json')
    return { store: new RoutingStore(file), file }
  }

  it('跨重啟保留', () => {
    const { store, file } = tempStore()
    store.replace({ rules: [rule('r1', 'title', 'x', 'f1')], fallbackFolderId: 'f2' })

    const reloaded = new RoutingStore(file)
    reloaded.load()
    assert.equal(reloaded.get().rules.length, 1)
    assert.equal(reloaded.get().fallbackFolderId, 'f2')
  })

  it('不與使用者偏好共用檔案', () => {
    // **對照組**：把規則放進 `preferences.json` → 這條必須變紅
    // （`save()` 整份重建 ＋ `setTerminalFont()` 從空物件重建）。
    const { file } = tempStore()
    assert.equal(path.basename(file), 'intake-routing.json')
  })

  it('形狀不合的單條被忽略，其餘照常生效', () => {
    const parsed = parseRoutingFile(
      JSON.stringify({
        version: ROUTING_VERSION,
        rules: [
          { id: 'good', criterion: 'title', contains: 'x', folderId: 'f1' },
          { id: 'bad-criterion', criterion: 'nonsense', contains: 'x', folderId: 'f1' },
          { id: 'bad-folder', criterion: 'title', contains: 'x', folderId: 42 },
        ],
        fallbackFolderId: 'f2',
      }),
    )
    // **斷言用行為而非長度**：留下來的那條要真的解析得出正確的 folder。
    assert.ok(parsed)
    assert.deepEqual(resolveRouting(parsed, intake({ title: 'x' }), FOLDERS), { ok: true, folderId: 'f1' })
    assert.equal(parsed.fallbackFolderId, 'f2')
  })

  it('版本不符時整份視為未設定', () => {
    assert.equal(parseRoutingFile(JSON.stringify({ version: ROUTING_VERSION + 1, rules: [] })), null)
  })

  it('損毀的 JSON 回 null 而非拋出', () => {
    assert.equal(parseRoutingFile('{nope'), null)
  })
})

describe('已由接收端解析出目標的 intake', () => {
  const addressed = (folderId: string): Intake => ({
    id: 'h1',
    verified: { adapter: 'handoff', originKind: 'session', originId: 'f1', targetFolderId: folderId },
    authored: { title: 't', body: 'b', actor: 'a', originLabel: 'alpha' },
    receivedAt: 0,
  })

  it('不比對規則 —— 一條會命中並指向別處的規則不影響結果', () => {
    const config: RoutingConfig = {
      rules: [{ id: 'r1', criterion: 'body', contains: 'b', folderId: 'fB' }],
      fallbackFolderId: null,
    }
    assert.deepEqual(resolveRouting(config, addressed('fA'), new Set(['fA', 'fB'])), {
      ok: true,
      folderId: 'fA',
    })
  })

  it('不落到 fallback', () => {
    const config: RoutingConfig = { rules: [], fallbackFolderId: 'fB' }
    assert.deepEqual(resolveRouting(config, addressed('fA'), new Set(['fA', 'fB'])), {
      ok: true,
      folderId: 'fA',
    })
  })

  it('目標已被移出 workspace 時拒絕，即使 fallback 可用', () => {
    const config: RoutingConfig = { rules: [], fallbackFolderId: 'fB' }
    assert.deepEqual(resolveRouting(config, addressed('fGone'), new Set(['fB'])), {
      ok: false,
      reason: 'FOLDER_GONE',
      folderId: 'fGone',
    })
  })

  it('a named target that resolved to no folder is refused, never matched by a rule or the fallback', () => {
    const config: RoutingConfig = {
      rules: [{ id: 'r1', criterion: 'body', contains: 'b', folderId: 'fB' }],
      fallbackFolderId: 'fB',
    }
    const unresolved: Intake = {
      id: 'h1-r1',
      verified: { adapter: 'handoff', originKind: 'session', originId: 'f1', targetText: '/home/me/gone' },
      authored: { title: 't', body: 'b', actor: 'a', originLabel: 'alpha' },
      receivedAt: 0,
    }
    assert.deepEqual(resolveRouting(config, unresolved, new Set(['fB'])), { ok: false, reason: 'FOLDER_GONE' })
  })
})
