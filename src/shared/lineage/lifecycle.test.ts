import assert from 'node:assert/strict'
import test from 'node:test'

import { lifecycleOf, onReportAdopted, onWaitTick, parseCompletion, type CompletionState, type WaitValue } from './lifecycle'

/** 從採納報告開始，依序餵入一串輪詢值。 */
function run(ticks: WaitValue[], start: CompletionState | undefined = onReportAdopted(1)): CompletionState | undefined {
  let state: CompletionState | undefined = start
  ticks.forEach((wait, i) => {
    state = onWaitTick(state, wait, 100 + i)
  })
  return state
}

test('報告之後的收尾不推翻完成：忙碌、再就緒 ⇒ 仍為已完成', () => {
  // **對照組**：把「落定之前的忙碌」也當成重新開始 → 這條必須變紅。
  const state = run(['busy', 'ready'])
  assert.equal(lifecycleOf(state, 'ready', false), 'done')
  assert.equal(state?.settled, true)
})

test('報告於 agent 已停下之後才被採納：採納之後第一次輪詢就是就緒 ⇒ 落定；其後忙碌 ⇒ 進行中', () => {
  // **對照組**：落定改為依「轉變為就緒」（前一個值不是就緒才算）→ 這條必須變紅。
  const state = run(['ready', 'busy'])
  assert.equal(lifecycleOf(state, 'busy', false), 'working')
})

test('完成之後再被交辦即重新開始，且先前的完成時刻保留', () => {
  const state = run(['ready', 'busy'])
  assert.equal(state?.reportedAt, 1)
  assert.equal(typeof state?.reopenedAt, 'number')
  assert.equal(lifecycleOf(state, 'ready', false), 'waiting')
})

test('等待選擇也算重新開始（落定之後）', () => {
  assert.equal(lifecycleOf(run(['ready', 'awaiting-choice']), 'awaiting-choice', false), 'waiting')
})

test('未知不觸發落定也不觸發重新開始', () => {
  assert.equal(run(['unknown'])?.settled, false)
  const settled = run(['ready', 'unknown'])
  assert.equal(settled?.reopenedAt, undefined)
  assert.equal(lifecycleOf(settled, 'unknown', false), 'done')
})

test('沒有報告時依等待狀態呈現；未知時不呈現', () => {
  assert.equal(lifecycleOf(undefined, 'ready', false), 'waiting')
  assert.equal(lifecycleOf(undefined, 'awaiting-choice', false), 'waiting')
  assert.equal(lifecycleOf(undefined, 'busy', false), 'working')
  assert.equal(lifecycleOf(undefined, 'unknown', false), 'idle')
})

test('後到的報告取代先前的：重新開始之後再報告 ⇒ 回到已完成、未落定', () => {
  const reopened = run(['ready', 'busy'])
  assert.equal(lifecycleOf(reopened, 'busy', false), 'working')
  const again = onReportAdopted(500)
  assert.equal(lifecycleOf(again, 'busy', false), 'done')
  assert.equal(again.reopenedAt, undefined)
})

test('沒有改變時回傳同一個物件（呼叫端據此決定要不要落盤）', () => {
  const settled = run(['ready'])
  assert.equal(onWaitTick(settled, 'ready', 999), settled)
  assert.equal(onWaitTick(undefined, 'busy', 999), undefined)
})

test('落盤形狀：壞掉的丟棄', () => {
  assert.deepEqual(parseCompletion({ reportedAt: 1, settled: true }), { reportedAt: 1, settled: true })
  assert.deepEqual(parseCompletion({ reportedAt: 1, settled: false, reopenedAt: 2 }), { reportedAt: 1, settled: false, reopenedAt: 2 })
  assert.equal(parseCompletion({ reportedAt: 'x', settled: true }), undefined)
  assert.equal(parseCompletion({ reportedAt: 1 }), undefined)
  assert.equal(parseCompletion(null), undefined)
})

test('收掉已完成：只關列出的且確認當下仍為已完成的', async () => {
  const { closableNow } = await import('./lifecycle')
  const doneNow = new Set(['a', 'c', 'late'])
  // 'b' 在對話框開著時重新開始了；'late' 在對話框開著時才完成、沒被列出。
  assert.deepEqual(closableNow(['a', 'b', 'c'], (id) => doneNow.has(id)), ['a', 'c'])
})

test('a ready child the user has looked at is not waiting; busy is working whatever the mark says', () => {
  assert.equal(lifecycleOf(undefined, 'ready', true), 'idle')
  assert.equal(lifecycleOf(undefined, 'ready', false), 'waiting')
  assert.equal(lifecycleOf(undefined, 'awaiting-choice', true), 'waiting')
  assert.equal(lifecycleOf(undefined, 'busy', true), 'working')
  assert.equal(lifecycleOf(undefined, 'unknown', false), 'idle')
  assert.equal(lifecycleOf(onReportAdopted(1), 'ready', false), 'done', 'done regardless of the mark')
})
