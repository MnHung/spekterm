/**
 * `scripts/lib/cdp.mjs` 的**傳輸層**單元測試 —— 每一次往返都必須在有限時間內返回。
 *
 * ## 為什麼這一族必須在單元測試層擋住
 *
 * 它們要防的是 **hang**，而 hang 在探針層的症狀是「還在跑」：issue #22 的代價是一輪
 * `test:e2e` 卡住 1 小時 30 分且永遠不會結束，`docs/lessons/probes.md` 更記載它「看起來像
 * Electron 啟動很慢」。**一個永遠不結束的失敗，沒有辦法在端到端層被觀察到。**
 *
 * ## 每一條都自帶 timeout，這不是形式
 *
 * 把機制拿掉時，這些測試會**掛住**而不是變紅 —— 那正是被修的失效形狀。沒有 `timeout` 的話，
 * 對照組會讓整輪 `npm test` 停住，而 `npm test` 的定位是「改完就跑」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { CALL_TIMEOUT_MS, CONNECT_TIMEOUT_MS, connect, connectToApp } from './lib/cdp.mjs'

/**
 * **The instruments' diagnostics go to stderr in this file.** `pollFor` prints its exhausted-wait line (`⏱ …`) with
 * `console.log`, and these tests exhaust waits on purpose. In a test file's child process stdout is also the
 * channel the `node:test` runner reads its serialized results from, and under load the runner failed to parse it
 * ("Unable to deserialize cloned data due to invalid or unsupported version"): 3 of 5 full `npm test` runs on the
 * `agent-session-control` tree, 0 of 5 without it (the extra test files change the scheduling). The probes keep
 * printing to stdout; only this file moves.
 */
console.log = (...args) => console.error(...args)

/** 每條測試的上限 —— 遠大於測試自訂的毫秒級時限，遠小於預設的 30 秒。 */
const TEST_TIMEOUT = 3_000

/**
 * 一個假的 WebSocket。
 *
 * `respond` 決定它怎麼回應送出的訊息：`'echo'` 立即回一個成功結果、`'silent'` 什麼都不回
 * （這是「回應永不抵達」）。
 */
function fakeSocket({ respond = 'echo', autoOpen = true } = {}) {
  const listeners = new Map()
  const socket = {
    sent: [],
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(handler)
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler)
    },
    send(raw) {
      socket.sent.push(JSON.parse(raw))
      if (respond === 'echo') {
        const { id } = JSON.parse(raw)
        queueMicrotask(() => socket.emit('message', { data: JSON.stringify({ id, result: { ok: 1 } }) }))
      }
    },
    close() {
      socket.emit('close', {})
    },
    emit(type, event) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event)
    },
  }
  if (autoOpen) queueMicrotask(() => socket.emit('open', {}))
  return socket
}

const connectFake = (socket, options = {}) =>
  connect({ webSocketDebuggerUrl: 'ws://fake' }, { createSocket: () => socket, ...options })

test('回應永不抵達時，該次往返逾時且訊息載明方法名', { timeout: TEST_TIMEOUT }, async () => {
  const client = await connectFake(fakeSocket({ respond: 'silent' }), { callTimeoutMs: 40 })
  await assert.rejects(
    () => client.send('Runtime.evaluate', {}),
    // **方法名是承重的**：`Input.dispatchMouseEvent` 逾時與 `Runtime.evaluate` 逾時是兩個病。
    /CDP 往返逾時（40ms）：Runtime\.evaluate/,
  )
})

test('連線關閉使尚未完成的往返立即失敗', { timeout: TEST_TIMEOUT }, async () => {
  const socket = fakeSocket({ respond: 'silent' })
  const client = await connectFake(socket, { callTimeoutMs: 60_000 })

  // 時限訂成 60 秒：**這條驗的不是逾時，是關閉** —— 若它靠逾時才 reject，這條就會超過自己的
  // timeout 而失敗（而不是靜靜地通過）。
  const inflight = client.send('Runtime.evaluate', {})
  socket.close()
  await assert.rejects(() => inflight, /CDP 連線已關閉/)
})

test('呼叫端主動 close() 同樣讓 pending 立即失敗（不等 close 事件）', { timeout: TEST_TIMEOUT }, async () => {
  const socket = fakeSocket({ respond: 'silent' })
  const client = await connectFake(socket, { callTimeoutMs: 60_000 })
  const inflight = client.send('Runtime.evaluate', {})
  client.close()
  await assert.rejects(() => inflight, /已由呼叫端關閉|已關閉/)
})

test('連線關閉後發起的往返立即失敗，且耗時遠小於時限', { timeout: TEST_TIMEOUT }, async () => {
  const socket = fakeSocket({ respond: 'silent' })
  const client = await connectFake(socket, { callTimeoutMs: 60_000 })
  client.close()

  // **耗時的量測是這條的鑑別力**：少了它，一個「等滿時限才拋」的實作也會通過。
  const started = Date.now()
  await assert.rejects(() => client.send('Runtime.evaluate', {}), /不再送出：Runtime\.evaluate/)
  assert.ok(Date.now() - started < 100, `應立即失敗，實得 ${Date.now() - started}ms`)
})

test('一次逾時之後，連線仍然可用', { timeout: TEST_TIMEOUT }, async () => {
  // **逾時不判死整條連線**：呼叫端多半在輪詢之內，把連線判死會讓一次偶發的慢變成永久的失敗。
  let mode = 'silent'
  const socket = fakeSocket({ respond: 'manual' })
  socket.send = function send(raw) {
    const { id } = JSON.parse(raw)
    socket.sent.push(JSON.parse(raw))
    if (mode === 'echo') {
      queueMicrotask(() => socket.emit('message', { data: JSON.stringify({ id, result: { ok: 1 } }) }))
    }
  }
  const client = await connectFake(socket, { callTimeoutMs: 40 })

  await assert.rejects(() => client.send('Runtime.evaluate', {}), /逾時/)
  mode = 'echo'
  assert.deepEqual(await client.send('Runtime.evaluate', {}), { ok: 1 })
})

test('握手不完成時，connect() 逾時', { timeout: TEST_TIMEOUT }, async () => {
  // `open` 與 `error` 都不來 —— 現況會永遠等，而它在每一支探針的啟動路徑上。
  const socket = fakeSocket({ autoOpen: false })
  await assert.rejects(() => connectFake(socket, { connectTimeoutMs: 40 }), /握手逾時（40ms）/)
})

test('未注入時採用預設常數', { timeout: TEST_TIMEOUT }, async () => {
  // 以匯出的常數比對，**不重寫數字** —— 否則改了預設值而忘記改測試時，這裡會紅在一個
  // 與行為無關的地方。
  assert.equal(typeof CALL_TIMEOUT_MS, 'number')
  assert.equal(typeof CONNECT_TIMEOUT_MS, 'number')
  assert.ok(CALL_TIMEOUT_MS >= 10_000, '它是癱瘓的防線，不是效能的閘門')

  const socket = fakeSocket()
  const client = await connectFake(socket)
  assert.deepEqual(await client.send('Runtime.evaluate', {}), { ok: 1 })
  client.close()
})

// ── connectToApp：握手失敗要重試，而探詢失敗不重試 ──────────────────────────

/**
 * 起一個假的 devtools endpoint。**用真的 HTTP server 而不是攔截 `fetch`** —— 這一族的判準是
 * 「每一輪有沒有重新探詢」，而那唯一誠實的量法就是數 server 收到幾次請求。
 */
async function withTargetServer(handler, fn) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn(server.address().port)
  } finally {
    server.close()
  }
}

/** 回一份正常的 target 清單，並計數被問了幾次。 */
function targetEndpoint(counter) {
  return (req, res) => {
    counter.hits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([{ type: 'page', webSocketDebuggerUrl: `ws://fake/${counter.hits}` }]))
  }
}

test('connectToApp：第一次握手失敗、其後成功時連線建立成功', { timeout: TEST_TIMEOUT }, async () => {
  const counter = { hits: 0 }
  let handshakes = 0
  await withTargetServer(targetEndpoint(counter), async (port) => {
    const client = await connectToApp(port, {
      targetTimeoutMs: 300,
      connectTimeoutMs: 60,
      budgetMs: 1500,
      createSocket: () => {
        handshakes += 1
        // 前兩次以 error 事件失敗，第三次正常開起來。
        const socket = fakeSocket({ autoOpen: handshakes >= 3 })
        if (handshakes < 3) queueMicrotask(() => socket.emit('error', { error: new Error('ECONNRESET') }))
        return socket
      },
    })
    assert.ok(client, '一次性的握手失敗不該讓整支探針中斷（issue #7）')
    client.close()
  })
  assert.equal(handshakes, 3)
})

test('connectToApp：每一輪重新探詢 target，不重用快照', { timeout: TEST_TIMEOUT }, async () => {
  // **這是這個入口存在的關鍵**：target 若已消失，重試同一個位址永遠不會成功 ——
  // 那樣的重試比不重試更糟，它把一次快速失敗換成等滿整個窗口。
  const counter = { hits: 0 }
  const urls = []
  await withTargetServer(targetEndpoint(counter), async (port) => {
    let handshakes = 0
    const client = await connectToApp(port, {
      targetTimeoutMs: 300,
      connectTimeoutMs: 60,
      budgetMs: 1500,
      createSocket: (url) => {
        urls.push(url)
        handshakes += 1
        const socket = fakeSocket({ autoOpen: handshakes >= 3 })
        if (handshakes < 3) queueMicrotask(() => socket.emit('error', { error: new Error('boom') }))
        return socket
      },
    })
    client.close()
  })
  assert.ok(counter.hits >= 3, `每一輪都要重新問一次 endpoint，實際 ${counter.hits} 次`)
  assert.equal(new Set(urls).size, urls.length, `每一輪拿到的是新的 target，實際 ${JSON.stringify(urls)}`)
})

test('connectToApp：探詢失敗時立即終止，不進入重試', { timeout: TEST_TIMEOUT }, async () => {
  // 探詢失敗的意思是「app 已經不在」—— 重試它只會把「立刻失敗並指出處置」變成 N 倍的等待。
  const started = Date.now()
  await withTargetServer(
    (req, res) => {
      res.writeHead(500)
      res.end('nope')
    },
    async (port) => {
      await assert.rejects(
        () => connectToApp(port, { targetTimeoutMs: 120, connectTimeoutMs: 60, budgetMs: 5000 }),
        /等待 CDP target 逾時/,
        '拋的必須是探詢自己的訊息（它會查 port 持有者並給出兩種解釋）',
      )
    },
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed < 2000, `應在一個探詢窗口內結束，而不是燒完 5 秒的預算（實際 ${elapsed}ms）`)
})

test('connectToApp：預算耗盡的訊息載明 error 內容與 target 存否', { timeout: TEST_TIMEOUT }, async () => {
  const counter = { hits: 0 }
  await withTargetServer(targetEndpoint(counter), async (port) => {
    await assert.rejects(
      () =>
        connectToApp(port, {
          targetTimeoutMs: 200,
          connectTimeoutMs: 40,
          budgetMs: 250,
          createSocket: () => {
            const socket = fakeSocket({ autoOpen: false })
            queueMicrotask(() => socket.emit('error', { error: Object.assign(new Error('拒絕連線'), { code: 'ECONNREFUSED' }) }))
            return socket
          },
        }),
      (error) => {
        // 沒有主詞的「連線失敗」正是這條要消滅的東西 —— 三種成因的處置完全不同。
        assert.match(error.message, /ECONNREFUSED/, '要載明 error 事件實際帶著什麼')
        assert.match(error.message, /可連線的 page/, '要載明 target 當下還在不在')
        return true
      },
    )
  })
})

test('connectToApp：每一次失敗的 socket 都被關閉，不殘留 listener', { timeout: TEST_TIMEOUT }, async () => {
  const counter = { hits: 0 }
  const sockets = []
  await withTargetServer(targetEndpoint(counter), async (port) => {
    await assert.rejects(() =>
      connectToApp(port, {
        targetTimeoutMs: 200,
        connectTimeoutMs: 40,
        budgetMs: 250,
        createSocket: () => {
          const socket = fakeSocket({ autoOpen: false })
          socket.closed = 0
          const close = socket.close
          socket.close = () => {
            socket.closed += 1
            close()
          }
          sockets.push(socket)
          queueMicrotask(() => socket.emit('error', { error: new Error('boom') }))
          return socket
        },
      }),
    )
  })
  assert.ok(sockets.length >= 1)
  for (const socket of sockets) {
    assert.ok(socket.closed >= 1, '重試會製造多個半死的連線，各自還掛著 listener')
  }
})
