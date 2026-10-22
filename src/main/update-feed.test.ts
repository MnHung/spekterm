import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { readUpdateFeed } from './update-feed'

const file = (content: unknown) => () => JSON.stringify(content)

describe('readUpdateFeed', () => {
  it('opens nothing without a throwaway profile', () => {
    let opened = 0
    const feed = readUpdateFeed({
      throwawayProfile: false,
      userData: '/profile',
      readFile: () => {
        opened++
        return JSON.stringify({ releaseApiUrl: 'http://127.0.0.1:1/' })
      },
    })
    assert.equal(feed, null)
    assert.equal(opened, 0)
  })

  it('reads the probe feed of a throwaway profile', () => {
    let read = ''
    const feed = readUpdateFeed({
      throwawayProfile: true,
      userData: '/profile',
      readFile: (target) => {
        read = target
        return JSON.stringify({ updateConfigPath: '/scratch/app-update.yml', releaseApiUrl: 'http://127.0.0.1:4567/latest', firstDelayMs: 500 })
      },
    })
    assert.equal(read, path.join('/profile', 'update-feed.json'))
    assert.deepEqual(feed, {
      updateConfigPath: '/scratch/app-update.yml',
      releaseApiUrl: 'http://127.0.0.1:4567/latest',
      firstDelayMs: 500,
    })
  })

  it('refuses another host, a relative config path, and junk', () => {
    const userData = '/profile'
    assert.equal(readUpdateFeed({ throwawayProfile: true, userData, readFile: file({ releaseApiUrl: 'https://api.github.com/x' }) }), null)
    assert.equal(readUpdateFeed({ throwawayProfile: true, userData, readFile: file({ updateConfigPath: 'app-update.yml' }) }), null)
    assert.equal(readUpdateFeed({ throwawayProfile: true, userData, readFile: () => 'not json' }), null)
    assert.equal(
      readUpdateFeed({ throwawayProfile: true, userData, readFile: () => { throw new Error('ENOENT') } }),
      null,
    )
  })
})

describe('the feed gate in the wiring', () => {
  const read = (name: string) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), name), 'utf8')

  it('reads the feed only behind the throwaway-profile gate, which a packaged build never passes', () => {
    const index = read('index.ts')
    assert.match(index, /startUpdates\(\{\s*packaged: app\.isPackaged,\s*throwawayProfile: usingThrowawayProfile\(\)/)
    assert.match(index, /function usingThrowawayProfile\(\): boolean \{\s*if \(app\.isPackaged\) return false/)
    const service = read('update-service.ts')
    assert.match(service, /readUpdateFeed\(\{ throwawayProfile: options\.throwawayProfile,/)
    // A packaged build never hands the feed's config to the updater.
    assert.match(service, /updateConfigPath: options\.packaged \? undefined : feed\?\.updateConfigPath/)
  })
})
