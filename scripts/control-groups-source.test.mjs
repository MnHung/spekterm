/**
 * 對照組腳本自己的守衛。
 *
 * **一個 mutation 的 `from` 對不上原始碼時，那個對照組就等於不存在** —— 而症狀是靜默的：
 * 那支腳本平常沒有人跑（它要十幾分鐘、會重建好幾次 `out/`），於是「對照組壞了」與
 * 「對照組還在」在任何一次 `npm test`、typecheck、lint 或探針上都看不出差別。
 *
 * **實測踩過**：`slack-mention-intake` 改了 `failureFromError` 與 `#merge`，於是
 * `auth-merged-into-transient` 與 `failure-not-merged` 兩個對照組同時失效 ——
 * 而它們是在下一個 change 才被發現的（隔了一整輪封存）。
 *
 * `from` 要**恰有一處命中**，理由與對照表的載體標籤相同：`String.replace` 只換第一處，
 * 兩處命中時實際被改的是哪一處無法從腳本上讀出來。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { MUTATIONS as INTAKE } from './intake-control-groups.mjs'
import { MUTATIONS as SLACK } from './slack-control-groups.mjs'
import { MUTATIONS as TEAM } from './team-control-groups.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 一個字串在另一個字串裡出現幾次。 */
function countOf(haystack, needle) {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

for (const [label, mutations] of [
  ['intake', INTAKE],
  ['slack', SLACK],
  ['team', TEAM],
]) {
  test(`${label} 的每個 mutation 都還對得上原始碼`, () => {
    assert.ok(mutations.length > 0, '一份空的 mutation 清單會讓這條守衛恆真')
    const broken = []
    for (const mutation of mutations) {
      const source = readFileSync(join(repoRoot, mutation.file), 'utf8')
      const hits = countOf(source, mutation.from)
      if (hits !== 1) broken.push(`${mutation.name}：${mutation.file} 命中 ${hits} 次（要恰好 1 次）`)
    }
    assert.deepEqual(broken, [], '對照組的 from 對不上原始碼 —— 那個對照組等於不存在')
  })

  test(`${label} 的每個 mutation 都真的會改到東西`, () => {
    // `from === to` 的 mutation 與一個有效的 mutation，在輸出上長得一模一樣（都是綠的）。
    const noop = mutations.filter((mutation) => mutation.from === mutation.to).map((m) => m.name)
    assert.deepEqual(noop, [], 'from 與 to 相同 —— 這個對照組本身是假的')
  })

  test(`${label} 的每個 mutation 都指名了一條必須變紅的斷言`, () => {
    // 沒有指名的話，一個「因為別的理由紅了」的 mutation 會被當成通過。
    const unnamed = mutations
      .filter((mutation) => typeof mutation.expectRed !== 'string' || mutation.expectRed === '')
      .map((m) => m.name)
    assert.deepEqual(unnamed, [], '沒有指名斷言的 mutation')
  })
}
