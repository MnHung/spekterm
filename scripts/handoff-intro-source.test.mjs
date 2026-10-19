/**
 * 守衛：自我介紹裡的數字**不得寫死**。
 *
 * ## 為什麼需要一道守衛
 *
 * 投遞者沒有回饋管道 —— **一個未被告知的約束就是一條死路**：它照著手上那份說明去寫、
 * 被拒絕、然後回報自己已經交出去了。
 *
 * 而一份手寫的清單與實際生效的判定分屬兩處時，它們會在某一次調整之後分岔，
 * **分岔不會讓任何東西變紅**：型別過、測試過、探針過，只有 agent 收到一份過期的說明。
 * 這正是本 change 要修的那個 bug 的形狀（長度上限從未被告知）。
 *
 * 「改一下常數看輸出變不變」**對 `export const` 做不到**（測試裡改不了它），
 * 所以那不是常駐載體。這支才是。
 *
 * ## 走語法樹，不走行掃描
 *
 * 註解裡會寫到這些數字（本檔案自己就寫了）。行掃描分不開註解與程式碼，而豁免註解正是
 * 它的核心語意 —— 與 CJK 守衛同一條理由。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = 'src/main/handoff-intro.ts'

/**
 * 這些常數的值**不得以數字字面值出現在自我介紹裡**。
 *
 * 取自實際生效的那幾處 —— 本清單若與產品分岔，第一條測試就會因為找不到而失敗。
 */
const GUARDED = [
  { name: 'MAX_FIELD_LENGTH', file: 'src/main/intake-schema.ts' },
  { name: 'MAX_FIRST_PARTY_BODY_LENGTH', file: 'src/main/intake-schema.ts' },
  { name: 'MAX_DELIVERY_BYTES', file: 'src/main/intake-source.ts' },
  // 完成報告的摘要上限（handoff-completion）—— 子 session 的自我介紹會說出它。
  { name: 'MAX_REPORT_LENGTH', file: 'src/main/handoff-delivery.ts' },
  // The scheduling bound (scheduled-handoff) — every introduction states it, and the example time avoids its digits.
  { name: 'MAX_SCHEDULE_AHEAD_DAYS', file: 'src/main/handoff-delivery.ts' },
]

function constantValue(file, name) {
  const source = readFileSync(join(repoRoot, file), 'utf8')
  const match = source.match(new RegExp(`export const ${name} = ([0-9_*\\\\s]+)`))
  if (!match) return null
  // `512 * 1024`、`20_000` 等寫法都要吃。
  return Number(new Function(`return ${match[1].replace(/_/g, '')}`)())
}

/**
 * 該原始碼中所有**會被人讀到的文字**（字串字面值與模板字串的文字段），加上數字字面值。
 *
 * **不能只看數字字面值** —— 最自然的寫死形式是把數字打進字串裡：
 *
 * ```ts
 * `  body: at most 20000 characters.`
 * ```
 *
 * 那個 `20000` 在語法樹上是模板字串的**文字段**，不是 `NumericLiteral`。
 * 第一版的守衛只看後者，於是它抓不到它唯一要抓的東西（對照組當場紅了）。
 *
 * 註解不在語法樹的這些節點裡，所以豁免是免費的。
 */
export function writtenNumbers(source, fileName = TARGET) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const texts = []
  const visit = (node) => {
    if (ts.isNumericLiteral(node)) texts.push(node.text)
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) texts.push(node.text)
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      texts.push(node.text)
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return texts
}

/** 這些文字裡有沒有出現該數值（允許 `20000` 與 `20,000` 兩種寫法）。 */
function mentions(texts, value) {
  const forms = [String(value), value.toLocaleString('en-US')]
  return texts.some((text) => forms.some((form) => text.includes(form)))
}

test('被守護的常數都找得到 —— 清單本身沒有與產品分岔', () => {
  for (const { name, file } of GUARDED) {
    assert.notEqual(constantValue(file, name), null, `${file} 裡找不到 ${name}`)
  }
})

test('自我介紹不得寫死那些上限的值', () => {
  const texts = writtenNumbers(readFileSync(join(repoRoot, TARGET), 'utf8'))
  for (const { name, file } of GUARDED) {
    const value = constantValue(file, name)
    assert.equal(
      mentions(texts, value),
      false,
      `${TARGET} 寫死了 ${name} 的值（${value}）。` +
        '它必須由常數推導 —— 否則調整那個常數時，agent 會收到一份過期的說明，' +
        '而不會有任何東西變紅。',
    )
  }
})

test('對照組：寫死在模板字串裡時守衛必須變紅', () => {
  // **這是最自然的寫死形式**，而第一版的守衛（只看 NumericLiteral）抓不到它。
  const texts = writtenNumbers('const s = `  body: at most 20000 characters.`', 'mutated.ts')
  assert.ok(mentions(texts, 20_000), '模板字串的文字段裡的數字必須被看見')
})

test('對照組：寫死為數字字面值時守衛也要變紅', () => {
  const texts = writtenNumbers('const s = `at most ${20000} characters`', 'mutated2.ts')
  assert.ok(mentions(texts, 20_000))
})

test('對照組：註解裡寫到那個數字不算違規', () => {
  const texts = writtenNumbers('// 上限是 20000 字元，由常數推導。\nexport const x = 1', 'commented.ts')
  assert.equal(mentions(texts, 20_000), false, '註解不在語法樹的字串節點裡')
})
