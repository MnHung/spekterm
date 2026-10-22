import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { compareVersions, formatVersion, parseVersion, releasePageUrl } from './update-version'

describe('parseVersion', () => {
  it('reads x.y.z with or without the v prefix', () => {
    assert.deepEqual(parseVersion('0.2.18'), { major: 0, minor: 2, patch: 18 })
    assert.deepEqual(parseVersion('v1.10.0'), { major: 1, minor: 10, patch: 0 })
  })

  it('refuses pre-releases, junk and non-strings', () => {
    for (const text of ['1.2.3-beta.1', '1.2', 'v1.2.3.4', ' 1.2.3', '1.2.3\n', 'latest', '', 'V1.2.3', '1.2.x']) {
      assert.equal(parseVersion(text), null, JSON.stringify(text))
    }
    for (const value of [undefined, null, 123, { major: 1 }]) assert.equal(parseVersion(value), null)
  })

  it('refuses a field too large to be exact', () => {
    assert.equal(parseVersion('1.2.99999999999999999999'), null)
  })
})

describe('compareVersions', () => {
  const v = (text: string) => parseVersion(text)!

  it('compares numerically, not as text', () => {
    assert.ok(compareVersions(v('1.10.0'), v('1.9.9')) > 0)
    assert.ok(compareVersions(v('0.2.9'), v('0.2.10')) < 0)
    assert.equal(compareVersions(v('v0.2.18'), v('0.2.18')), 0)
    assert.ok(compareVersions(v('2.0.0'), v('1.99.99')) > 0)
  })
})

describe('releasePageUrl', () => {
  it('is built from the version', () => {
    assert.equal(releasePageUrl(parseVersion('0.2.18')!), 'https://github.com/spekhq/spekterm/releases/tag/v0.2.18')
    assert.equal(formatVersion(parseVersion('v3.0.1')!), '3.0.1')
  })
})
