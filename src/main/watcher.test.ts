import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import type { FSWatcher } from 'chokidar'
import { findPollingPath } from './polling-mount.testkit'
import { createWatcher } from './watcher'

/** chokidar 把生效的設定留在 `options` 上（其 `index.d.ts` 的公開介面）。 */
function usePollingOf(watcher: FSWatcher): boolean {
  return (watcher as unknown as { options: { usePolling: boolean } }).options.usePolling
}

let base: string
let watcher: FSWatcher | null

beforeEach(() => {
  base = fs.mkdtempSync(path.join(tmpdir(), 'spekterm-watcher-'))
  watcher = null
})

afterEach(async () => {
  // 不關掉的話 `node --test` 會一直等著這個 handle；spy 不還原則後續測試會失去 console.error。
  if (watcher) await watcher.close()
  mock.restoreAll()
  fs.rmSync(base, { recursive: true, force: true })
})

/**
 * 這些測試針對的是**錯誤路徑**，而錯誤路徑無法可靠地自然觸發（chokidar 的 `_handleError` 會過濾
 * 掉 `ENOENT` 與 `ENOTDIR`，剩下 `EPERM` / `EACCES` / `ENOSPC` 都需要特殊的檔案系統狀態）。
 * 因此以 `emit('error', …)` 直接送出事件 —— 驗的是**我們掛上去的 handler 收不收得到、會不會
 * 讓行程掛掉**，那正是本能力的規格內容。
 */
describe('createWatcher 的錯誤處理', () => {
  it('監看者發出錯誤時不造成未捕捉例外', () => {
    watcher = createWatcher({ target: base, label: base })

    // 沒有 'error' listener 時，Node 的 EventEmitter 會在此 throw ——
    // 而主行程一死，它底下所有 pty 跟著死（`src/` 下沒有任何 uncaughtException handler）。
    assert.doesNotThrow(() => {
      watcher?.emit('error', new Error('ENOSPC: System limit for number of file watchers reached'))
    })
  })

  it('回報指出是哪一個監看者出錯', () => {
    const spy = mock.method(console, 'error', () => {})
    const label = path.join(base, 'some', 'identifying', 'path')
    watcher = createWatcher({ target: base, label })

    watcher.emit('error', new Error('EACCES: permission denied'))

    assert.equal(spy.mock.callCount(), 1)
    const message = String(spy.mock.calls[0].arguments[0])
    // 少了 label，一則錯誤在數千個監看者之間無從定位。
    assert.ok(message.includes(label), `訊息未指出是哪一個監看者：${message}`)
    assert.ok(message.includes('EACCES: permission denied'), `訊息未含錯誤本身：${message}`)
  })

  it("掛上 'all' 不構成錯誤處理（chokidar 的 emitWithAll 對 error 跳過 all）", () => {
    // 這是 branch-service 曾經的處境：它兩層 watcher 都掛了 on('all')，看起來像是有在聽，
    // 但 error 事件根本不走 all —— 於是它一直是三個站點裡唯一會讓主行程掛掉的那個。
    watcher = createWatcher({ target: base, label: base })
    let seenByAll = false
    watcher.on('all', () => {
      seenByAll = true
    })

    watcher.emit('error', new Error('boom'))

    assert.equal(seenByAll, false)
  })
})

/**
 * 這一組驗的是**輪詢是否真的被啟用**，不是「呼叫端傳了什麼參數」。兩者的差別是承重的：
 * 後者在建立入口自己的解析邏輯改壞時不會失敗，而它與規格真正在乎的「這個監看者收不收得到
 * 事件」之間隔著一整層。
 *
 * 需要一個位於 FUSE 之類檔案系統上的路徑才有對比 —— 探測不到就略過，**且把略過印出來**：
 * 一個靜默略過的驗收與一個通過的驗收在輸出上無法區分。
 */
describe('createWatcher 的輪詢判定依據', () => {
  it('省略 pollingRoot 時以 target 判定', (t) => {
    const pollingTarget = findPollingPath(base)
    if (!pollingTarget) {
      console.log('  ↷ 略過：找不到需要輪詢的掛載點（或環境覆寫使對照組不成立）')
      return t.skip()
    }

    watcher = createWatcher({ target: pollingTarget, label: pollingTarget })

    assert.equal(usePollingOf(watcher), true, `未以 target 判定：${pollingTarget}`)
  })

  it('對照組：同一個 target 配一個本機 pollingRoot 時不啟用輪詢', (t) => {
    const pollingTarget = findPollingPath(base)
    if (!pollingTarget) {
      console.log('  ↷ 略過：找不到需要輪詢的掛載點（或環境覆寫使對照組不成立）')
      return t.skip()
    }

    // 少了這一條，上一條就分不出「以 target 判定」與「這台機器什麼都要輪詢」。
    watcher = createWatcher({ target: pollingTarget, pollingRoot: base, label: pollingTarget })

    assert.equal(usePollingOf(watcher), false)
  })

  it('顯式指定的共同根勝過 target', (t) => {
    const pollingTarget = findPollingPath(base)
    if (!pollingTarget) {
      console.log('  ↷ 略過：找不到需要輪詢的掛載點（或環境覆寫使對照組不成立）')
      return t.skip()
    }

    // 顯式傳入是服務多目標的監看者宣告「請以共同根判定」的方式，它必須仍然有效。
    watcher = createWatcher({ target: pollingTarget, pollingRoot: base, label: 'multi-target' })
    assert.equal(usePollingOf(watcher), false)

    void watcher.close()
    watcher = createWatcher({ target: base, pollingRoot: pollingTarget, label: 'multi-target' })
    assert.equal(usePollingOf(watcher), true)
  })

  it('省略時不啟用輪詢（本機路徑的基準，不依賴任何掛載點）', () => {
    // 上面三條在探測不到掛載點時會略過；這一條在任何機器上都跑得動，
    // 保證「省略 pollingRoot」這條路徑至少被執行過一次。
    watcher = createWatcher({ target: base, label: base })

    assert.equal(usePollingOf(watcher), false)
  })
})

describe('createWatcher passes the ignored predicate through', () => {
  it('an ignored subtree is neither watched nor reported, the rest is', async () => {
    const skipped = path.join(base, 'skipped')
    fs.mkdirSync(path.join(skipped, 'deep'), { recursive: true })
    fs.writeFileSync(path.join(skipped, 'deep', 'a.md'), 'a')
    fs.writeFileSync(path.join(base, 'kept.md'), 'k')

    const seen: string[] = []
    watcher = createWatcher({
      target: base,
      label: base,
      ignored: (p) => !path.relative(skipped, p).startsWith('..'),
    })
    watcher.on('all', (_event, p) => seen.push(path.relative(base, p)))
    await new Promise<void>((resolve) => watcher?.on('ready', () => resolve()))

    assert.equal(Object.keys(watcher.getWatched()).some((dir) => dir.startsWith(skipped)), false)

    fs.appendFileSync(path.join(skipped, 'deep', 'a.md'), 'x')
    fs.appendFileSync(path.join(base, 'kept.md'), 'x')
    const deadline = Date.now() + 3000
    while (!seen.includes('kept.md') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await new Promise((resolve) => setTimeout(resolve, 200))

    assert.deepEqual(seen, ['kept.md'])
  })
})
