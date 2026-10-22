import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { t } from '@shared/i18n'
import type { NotifyBackend, NotifyPayload } from './intake-notify'
import { createUpdateNotifier } from './update-notify'

function fakeBackend(usable = true) {
  const shown: NotifyPayload[] = []
  let activate: (() => void) | null = null
  const backend: NotifyBackend = {
    present: (payload) => shown.push(payload),
    usable: () => usable,
    onActivate: (handler) => {
      activate = () => handler([])
    },
  }
  return { backend, shown, activate: () => activate?.() }
}

describe('createUpdateNotifier', () => {
  it('says a ready update and an available one in our words', () => {
    const fake = fakeBackend()
    const notify = createUpdateNotifier({ backend: fake.backend, onActivate: () => {} })
    notify({ kind: 'ready', version: '0.2.18' })
    notify({ kind: 'available', version: '0.2.19' })
    assert.deepEqual(fake.shown, [
      { title: t('update.notifyReadyTitle', { version: '0.2.18' }), body: t('update.notifyReadyBody') },
      { title: t('update.notifyAvailableTitle', { version: '0.2.19' }), body: t('update.notifyAvailableBody') },
    ])
    assert.match(fake.shown[0].title, /0\.2\.18/)
  })

  it('opens About when activated', () => {
    const fake = fakeBackend()
    let opened = 0
    createUpdateNotifier({ backend: fake.backend, onActivate: () => opened++ })
    fake.activate()
    assert.equal(opened, 1)
  })

  it('shows nothing where notifications are not usable', () => {
    const fake = fakeBackend(false)
    createUpdateNotifier({ backend: fake.backend, onActivate: () => {} })({ kind: 'ready', version: '0.2.18' })
    assert.deepEqual(fake.shown, [])
  })
})
