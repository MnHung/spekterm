import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decideDraftCommit, decideNumberCommit, textOf } from './commit-field'

const size = (text: string, stored: number | null, badInput = false) =>
  decideNumberCommit({ text, badInput, stored, integer: true })

describe('decideNumberCommit (settings-sections D2)', () => {
  it('an unchanged value is not written', () => {
    assert.deepEqual(size('15', 15), { action: 'none' })
    assert.deepEqual(size(' 15 ', 15), { action: 'none' })
  })

  it('empty means the default, and is written only when something is stored', () => {
    assert.deepEqual(size('', 15), { action: 'commit', value: null })
    assert.deepEqual(size('', null), { action: 'none' })
  })

  it('bad input is rejected, never taken as empty', () => {
    // A number input reports "" for "1e"; the stored size must not be cleared.
    assert.deepEqual(size('', 15, true), { action: 'reject' })
  })

  it('text that is not a number is rejected', () => {
    assert.deepEqual(size('abc', 15), { action: 'reject' })
  })

  it('a two-digit value is one write of that value', () => {
    // The field commits on Enter or blur, so "14" typed in two keystrokes is decided once, as 14.
    assert.deepEqual(size('14', 15), { action: 'commit', value: 14 })
  })

  it('an integer field rounds, a decimal field does not', () => {
    assert.deepEqual(size('13.6', 15), { action: 'commit', value: 14 })
    assert.deepEqual(size('14.6', 15), { action: 'none' }, 'rounds to the stored value')
    assert.deepEqual(decideNumberCommit({ text: '1.2', badInput: false, stored: 1, integer: false }), {
      action: 'commit',
      value: 1.2,
    })
  })
})

describe('decideDraftCommit', () => {
  it('an empty draft changes nothing', () => {
    assert.deepEqual(decideDraftCommit('', 'https://custom.example.com/api'), { action: 'none' })
    assert.deepEqual(decideDraftCommit('   ', null), { action: 'none' })
  })

  it('a different value is written, trimmed', () => {
    assert.deepEqual(decideDraftCommit(' https://other.example.com/api ', null), {
      action: 'commit',
      value: 'https://other.example.com/api',
    })
  })

  it('the stored value is not written again', () => {
    assert.deepEqual(decideDraftCommit('https://a.example.com', 'https://a.example.com'), { action: 'none' })
  })
})

describe('textOf', () => {
  it('shows the stored value, or nothing for the default', () => {
    assert.equal(textOf(15), '15')
    assert.equal(textOf(null), '')
    assert.equal(textOf(undefined), '')
  })
})
