/**
 * 探針使用的 debugging port —— **唯一的宣告處**。
 *
 * ## 為什麼要有這份表
 *
 * 啟動前要檢查「這支探針要用的 port 通不通」（`preflight.mjs`），那個檢查就必須知道每支要用
 * 哪些 port。在這份表出現之前，八支探針各自宣告，於是那個問題沒有定義域。
 *
 * ## 形狀是「一支探針對應**一組** port」，不是一支一個
 *
 * 這不是為了將來的彈性 —— **現況就有一支用兩個**：`probe-identity` 啟動兩次（一次在預設環境、
 * 一次帶著 `XDG_CONFIG_HOME`），此前寫成 `DEBUG_PORT` 與 `DEBUG_PORT + 1`。一對一的表**放不下
 * 第二個**，於是那個 port 不會出現在表上：守衛看不見它、前置檢查也不會檢查它。
 * **一份漏掉一半的表比沒有表更糟** —— 它讓人以為問題已經被結構擋住了。
 *
 * ## 兩件事是刻意的
 *
 * - **`identity` 的兩個號碼不相鄰**（9221 / 9231）。它們原本是 9225 與 9225+1，而 9225 是
 *   `files` 的 dev port、9226 是 `terminal` 的 build port —— **一支同時撞到兩支**
 *   （`docs/lessons/probes.md` 的「為什麼不平行化」以此為理由之一）。若改成 9221/9222 就會撞上
 *   `shell`；取不相鄰的號碼，是為了讓下一個順手寫 `+ 1` 的人不會直接撞進隔壁那一支。
 * - **`core` 與 `native` 不在表上，而且不得補進來。** `probe-core` 的驗收內容之一就是
 *   「主行程掃描 OpenSpec 時**不開任何 TCP 埠**」；給它一個 debugging port 會讓它**依設計失敗**。
 *   `probe-native` 自己就是一個 Electron 主行程，不經 CDP。
 *
 * 守衛在 `scripts/ports.test.mjs`：表上不得有重複的號碼，探針裡不得再出現 port 的數字字面，
 * 也不得對這份表的成員做算術。
 */

/**
 * 探針用到的**其他**監聽 port（不是 debugging port）。
 *
 * 它們同樣必須登記在這裡：**一個寫在探針裡的數字字面，下一支探針不會知道它被佔用了**，
 * 而撞號的症狀是「替身收不到呼叫」——那看起來像產品沒有去打它。
 */
export const STUB_PORTS = {
  /** 替身 Slack 的 HTTPS 伺服器。 */
  slack: 18443,
  /**
   * The remote access listener (`probe-remote.mjs`). **Never the product default 47615**: a maintainer's own
   * Spekterm with remote access on holds that one, and the probe would talk to it. Two, because the probe
   * moves the listener from one to the other and holds one itself to cause a conflict.
   */
  remoteListener: 18471,
  remoteListenerAlt: 18472,
}

/** 探針名 → 該支所有 debugging port（鍵名說明它是哪一次啟動）。 */
export const PROBE_PORTS = {
  /**
   * Two launches: the fresh profile, and one an earlier version left with a registered spell-check
   * dictionary (`workspace-app-shell`'s no-connection-at-startup check). The second is started only after
   * the first has quit, but its own port keeps `connectToApp` from reaching a lingering first app.
   */
  shell: { main: 9222, upgrade: 9247 },
  workspace: { main: 9223 },
  files: { build: 9224, dev: 9225 },
  terminal: { build: 9226, dev: 9227 },
  openspec: { build: 9228, dev: 9229 },
  keyboard: { build: 9234, dev: 9235 },
  /** 兩次啟動：預設環境，以及帶 `XDG_CONFIG_HOME` 的那一次。**號碼刻意不相鄰**（見檔頭）。 */
  identity: { default: 9221, xdgHome: 9231 },
  /**
   * 兩次啟動：帶 fixture 的那一個，以及驗空狀態的那一個。
   *
   * **第二個 port 不是可有可無的。** 空狀態的段落會在共用的 app 還活著時另起一個 app ——
   * 同一個 port 上 `connectToApp` 會連到**先起來的那一個**，於是「空來源」的斷言讀到的是
   * fixture 的資料。實測踩過：畫面上明明白白寫著 12 則訊息。
   */
  insights: { main: 9236, empty: 9237 },
  /**
   * 兩次啟動：第一次建立並操作，第二次**以同一份 profile 重建**。
   *
   * 第二個 port 不是可有可無的：重建那一段必須在第一個 app 完全收掉之後另起一個，而同一個 port
   * 上 `connectToApp` 會連到先起來的那一個 —— 比照 `insights` 的兩個 port 學到的同一件事。
   */
  agentView: { main: 9238, restore: 9239 },
  /**
   * 兩次啟動：第一次讓回補跑完並交付，第二次**以同一份 profile、但水位已被清掉**重啟 ——
   * 那是「取回位置遺失之後不重複交付」唯一的載體。
   *
   * 第二個 port 不是可有可無的（比照 `insights` / `agentView` / `intake` 學到的同一件事）：
   * 同一個 port 上 `connectToApp` 會連到先起來的那一個。
   */
  slack: { main: 9243, restart: 9244 },
  /**
   * 兩次啟動：主要的那一次，以及**以同一份 profile 重啟**的那一次。
   *
   * 第二個 port 不是可有可無的：「app 關閉期間投遞的 intake 於下次啟動時進入收件匣」
   * 這條要先關掉第一個 app、寫檔、再起第二個 —— 同一個 port 上 `connectToApp` 會連到
   * 先起來的那一個（比照 `insights` 與 `agentView` 學到的同一件事）。
   */
  intake: { main: 9241, restart: 9242 },
  package: { main: 9240 },
  /**
   * Two launches: the main one, and one **on the same profile after a restart** (the listener is on again
   * with the same certificate). The second port follows the `intake` lesson above.
   */
  remote: { main: 9250, restart: 9251 },
  /** The macOS packaging acceptance (`probe-package-mac.mjs`), run on a Mac, never in `test:e2e`. */
  packageMac: { main: 9249 },
  /** Not a probe: the website's screenshot capture (`scripts/capture-screenshots.mjs`) drives the built app. */
  screenshots: { main: 9248 },
}

/**
 * 一支探針會用到的全部 port。
 *
 * 不在表上的探針（`core` / `native`）回空陣列 —— **那不是錯誤**，它們本來就不經 CDP，
 * 前置檢查對它們沒有東西要檢查。
 */
export function portsOf(name) {
  return Object.values(PROBE_PORTS[name] ?? {})
}

/** 全部 port，攤平。守衛用它檢查重複。 */
export function allPorts() {
  return Object.values(PROBE_PORTS).flatMap((entry) => Object.values(entry))
}
