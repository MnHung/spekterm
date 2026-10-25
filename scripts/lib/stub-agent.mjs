import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/**
 * 替身 agent —— shared by `probe-agent-view`, `probe-intake`, `probe-remote` and `capture-screenshots`.
 *
 * 抽出來的理由不是「避免重複」：這支替身的每一個選項都對應一條實測結論
 * （逐位元組讀取為何不能換成 `exec cat`、`< /dev/tty` 為何不可省、就緒延遲為何必須可控），
 * **而兩份各抄一份的話，其中一份遲早會被簡化掉**，於是那些結論靜默失效。
 *
 * 呼叫端提供 `mkTemp`：暫存目錄的收屍記帳屬於各支探針自己。
 */
/**
 * 替身 agent。
 *
 * **它自己算紀錄的位置，用的是與產品相同的規則**（cwd 的每個非英數字元換成 `-`）。刻意不從
 * 產品那邊接一個路徑進來 —— 那樣兩邊就是同一個推導，而「產品算錯位置」這個失敗會變得表達不出來。
 */
/** A shell line appending a `skill_listing` record (shaped as CLI 2.1.304 writes it) to the stub's transcript. */
function listingLine(names, isInitial) {
  const record = {
    type: 'attachment',
    uuid: `skills-${names.join('-')}-${isInitial ? 'i' : 'd'}`,
    timestamp: '2026-10-20T00:00:00.000Z',
    attachment: {
      type: 'skill_listing',
      content: names.map((name) => `- ${name}: STUB-SKILL ${name}`).join('\n'),
      skillCount: names.length,
      isInitial,
      names,
    },
  }
  return `printf '%s\\n' '${JSON.stringify(record).replace(/'/g, "'\\''")}' >> "$tp"`
}

export function makeStubAgent(
  mkTemp,
  configDir,
  {
    honorHooks = true,
    echoDelaySeconds = 0,
    holdPermission = false,
    bulkRecords = 0,
    unreadable = false,
    relocateAfterInput = false,
    busySeconds = 0,
    /**
     * A text-only answer: after the submission, wait this long, write an assistant message and report
     * `Stop`, with **no tool event** in between. The wait state is busy for that time only because the
     * submission itself is reported (`UserPromptSubmit`) — that is what this option exists to show.
     */
    answerSeconds = 0,
    /**
     * Record each input line as the agent records a message typed while it runs tools: a `queued_command`
     * attachment **instead of** the `user` record (measured, CLI 2.1.300). Writing both would let the `user`
     * record clear the "not confirmed" label by itself, and the projection would never be exercised.
     */
    queuedDelivery = false,
    /**
     * Record each input line as the agent records a reply it took as a paste: the whole message inside
     * `<pasted_content id="…">` markers (measured, CLI 2.1.300). The conversation must show the text without
     * them, or "not confirmed" never clears for a long reply (`agent-transcript-stream`).
     */
    pasteWrap = false,
    /**
     * `fire SessionStart` 之前先等這麼久，並在 fire 的當下寫一個 receipt 檔。
     *
     * **少了它，「就緒之前不寫入」那條斷言紅不了**：既有的替身在任何等待之前就 fire，
     * 於是 ready 在 pty 誕生後數毫秒就到 ——「建立後立即寫入」的錯誤實作與正確實作
     * **落在同一個不可分辨的瞬間**。
     *
     * 值要**大於產品的 drain tick（400ms）＋ 呼叫端的輪詢間隔**，否則「整段期間」可能只
     * 包含一次取樣，而那是時序不是行為。
     */
    readyDelaySeconds = 0,
    /**
     * 就緒之後宣告一個終端標題（OSC 0）。
     *
     * **預設關閉** —— 既有的探針以分頁標籤定位元素，讓每個 session 憑空多一個標題會動到
     * 它們的選擇器。只有要驗「系統不代為命名」的段落需要它。
     */
    announceTitle = '',
    /**
     * Ask the terminal for two modes (DECRQM, `CSI ? 2026 $ p` and `CSI ? 1016 $ p`) before and after `SessionStart`,
     * as the real CLI does since 2.1.303 (measured, `remote-prefill-send`). xterm.js answers each into the pty, and the
     * product must not take the answers for someone typing. **Off by default**: the answers land in the byte receipts.
     */
    queryModes = false,
    /**
     * **吞掉每個 session 收到的第一個送出字元**（它不結束一行，那一行繼續累積）。
     *
     * 模擬真實 CLI 的一個實測行為：首次就緒時寫入的 `prompt\r` 偶爾只有文字進了輸入框、送出字元
     * 沒有生效（2.1.283，1/13，`docs/lessons/handoff.md` 第十三節）。產品對它的退路是「一段時間內
     * 沒見到開始工作就呈現待送出」—— 少了這個選項，那條退路沒有載體。
     */
    dropFirstSubmit = false,
    /**
     * A transcript file written to the session's transcript path **instead of** the `STUB-HELLO-<sid>`
     * message, on every start (`--session-id` and `--resume` alike). The website's screenshots use it so
     * the conversation view shows a prepared exchange — the path contains the session id, known only at
     * spawn, so the fixture cannot be placed beforehand.
     */
    transcriptFixture = '',
    /**
     * Report `Stop` right after `SessionStart` at startup (the default, which every existing probe was written
     * against). A real agent's start or resume reports `SessionStart` only, so a startup `Stop` reads as a turn end:
     * `session-wait-indicator`'s "a started session is not waiting" cannot be shown with it, and a baseline taken
     * with it is already "waiting" — an unseen-turn assertion would pass whether the product detected turn ends or not.
     */
    startupStop = true,
    /**
     * Record a line starting with `/` as the agent records a slash command: only its markers, message first
     * (`<command-message>name</command-message>\n<command-name>/name</command-name>\n<command-args>args</command-args>`,
     * measured, CLI 2.1.304). The conversation must show the typed line, or a device's `/skill args` reply never
     * matches its entry (`agent-transcript-stream`). **Off by default**: existing probes assert on raw lines.
     */
    slashCommands = false,
    /**
     * The skills of an initial `skill_listing` record written at startup (the real agent writes it with the first
     * prompt; the follow reads the whole file either way). `null` writes none.
     */
    skillListing = null,
    /**
     * Ask the injected `PreModelSwitch` hook twice for every `/model <name>` line, as the real agent does for
     * a switch that computes two (from, to) pairs (measured, CLI 2.1.310: `haiku`, `opusplan`), with the measured
     * payload (compact JSON, `requested_model` lower-cased, `source` command). Each run's stdout is appended to
     * `modelHookLog`, `|`-terminated. The stub proves the command and the injection; whether the real agent
     * skips its box on `allow` is dogfood's to certify. **Off by default.**
     */
    modelSwitch = false,
  } = {},
) {
  const home = mkTemp('spekterm-agentview-stub-')
  const bin = join(home, '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  const sizeReceipt = join(home, 'stty-size')
  const inputLog = join(home, 'agent-input.log')
  /**
   * **逐位元組**的輸入收據（八進位，以空白分隔）。
   *
   * `inputLog` 只在收到行終止字元時才落盤 —— 而**預填刻意不附送出字元**，於是那些位元組
   * 永遠不會出現在那裡：「未寫入」對正確實作與錯誤實作**一樣是空的**。
   *
   * **但不能把 `read` 換成 `exec cat`**：`exec` 會接管行程，而那個迴圈同時負責補紀錄與
   * fire 事件 —— 換掉之後那些全停，症狀會是**產品那側的斷言變紅**。
   * 因此改為逐位元組讀取**並自行組行**，兩件事都做。
   */
  const byteLog = join(home, 'agent-input.bytes')
  /** `fire SessionStart` 的當下寫下 —— 呼叫端據它界定「就緒之前」那一段。 */
  const readyReceipt = join(home, 'ready-at')
  /** 每條 hook 命令的 stdout，各自一個檔（`<事件>-<第幾條>`）。 */
  const hookOutDir = join(home, 'hook-stdout')
  mkdirSync(hookOutDir, { recursive: true })
  /**
   * 每一次啟動拿到的固定名字（`agent-peer-name`）：一行一次，`<對話 id>\t<--name 的值>\t<環境變數的值>`。
   *
   * **兩個來源都記** —— 產品以環境變數交付、命令列只引用它；只記其中一個的話，「名字被拼進命令字串」
   * 與「環境變數沒帶」這兩種錯誤會各自對一半的斷言透明。以對話 id 為鍵：自癒會換對話 id，
   * 而那正是要驗「名字不變」的地方。
   */
  const nameLog = join(home, 'peer-names.log')
  /**
   * **每個 session 各自一份**的輸入收據（以對話 id 命名）：`<id>.bytes`（逐位元組）與 `<id>.lines`。
   *
   * 共用的那兩份（`inputLog` / `byteLog`）是**整個替身一份**，並行的 session 寫進同一個檔案 ——
   * 「這一則送到了**哪一個** session」「某個 session 什麼都沒收到」在它們上面都無從判定
   * （`docs/lessons/handoff.md` 5.1）。
   */
  const perSessionDir = join(home, 'per-session')
  mkdirSync(perSessionDir, { recursive: true })
  const commandDir = join(home, 'commands')
  mkdirSync(commandDir, { recursive: true })
  let commandSeq = 0

  const script = [
    '#!/bin/sh',
    /*
      這顆 pty 拿到的終端尺寸，**持續回報**。

      **一次性的讀取是一場競態，不是一條斷言。** pty 誕生時的尺寸本來就是那個暫定值，要等
      renderer 掛載並 fit 之後才會被校正 —— 只在啟動當下讀一次，量到的是「校正有沒有搶在替身
      之前到」，而不是「終端有沒有版面盒子」。實測那讓斷言時綠時紅，而**紅的時候看起來像產品
      壞了**。

      改為週期性覆寫，呼叫端則等它**最終**不再是暫定值：沒有版面盒子的話，校正永遠不會來，
      它就永遠停在暫定值 —— 那才是這條 requirement 真正的失效樣貌。

      **`< /dev/tty` 不可省。** POSIX 規定非互動 shell 的非同步命令其標準輸入預設為 `/dev/null`
      —— 於是背景迴圈裡的 `stty` 讀不到終端，回報恆為 0。徵狀與「產品沒有推送尺寸」完全一樣，
      而那會讓人去查產品。
    */
    `(while :; do stty size < /dev/tty > "${sizeReceipt}" 2>/dev/null || echo "0 0" > "${sizeReceipt}"; sleep 0.3; done) &`,
    // 對話識別碼由產品以 `--session-id` 或 `--resume` 指定，兩者都掃。
    'sid=""; prev=""; settings=""; pname="-"',
    'for a in "$@"; do',
    '  case "$prev" in --session-id|--resume) sid="$a" ;; --settings) settings="$a" ;; esac',
    '  case "$a" in --name=*) pname="${a#--name=}" ;; esac',
    '  prev="$a"',
    'done',
    `printf '%s\t%s\t%s\n' "$sid" "$pname" "\${SPEKTERM_PEER_NAME:--}" >> ${JSON.stringify(nameLog)}`,
    // 紀錄的位置：與產品相同的推導規則。
    `slug=$(printf %s "$PWD" | sed 's/[^0-9A-Za-z]/-/g')`,
    `dir="${configDir}/projects/$slug"`,
    'mkdir -p "$dir"',
    'tp="$dir/$sid.jsonl"',
    // 觸發注入的 hook。**照著設定檔裡真正的命令跑** —— 只看 argv 證明不了它能用。
    // `firej <event> <json>`: run the event's hook commands with this exact payload (a probe's command can
    // report a tool's input, a subagent's id or a turn's background tasks). `fire` is it with the base payload.
    'fire() {',
    `  firej "$1" "$(printf '{"hook_event_name":"%s","session_id":"%s","transcript_path":"%s","cwd":"%s"}' "$1" "$sid" "$tp" "$PWD")"`,
    '}',
    'firej() {',
    // `honorHooks: false` 的替身完全不觸發事件 —— 用來驗「內容與輸入是兩條獨立的路」：
    // 沒有事件 ⇒ 等待狀態恆為未知 ⇒ 送不出去，**但內容照樣讀得到**。
    honorHooks ? '  [ -n "$settings" ] || return 0' : '  return 0',
    /*
      **一個事件上的每一條命令都要跑，而且各自的 stdout 要分別留下。**

      此前這裡只取 `hooks[event][0].hooks[0].command` 並把 stdout 丟進 `/dev/null`。
      那讓兩條 requirement **結構上沒有載體**：「兩個功能貢獻同一組 hook 事件時皆被執行」
      （`claude-status-bridge`）與「自我介紹的內容取當下的值」（`agent-handoff-source`）——
      前者只跑第一條、後者的可觀察值就是 stdout。**而它們照樣會是綠的**，因為斷言碰不到。

      真實的 CLI 確實會把同一事件的多條命令都跑完（2026-09-17、CLI 2.1.274 實測，見
      `docs/lessons/handoff.md`）—— 替身在這件事上必須與它一致，否則驗收與現實分岔。

      **命令經 base64 傳遞**：它們含分號、引號，且原則上可以含換行 —— 逐行讀取原文會把一條
      命令拆成兩條，而症狀是「hook 每次都失敗而事件目錄安靜地空著」（這個坑 repo 踩過一次，
      見 `agent-events` 的 `EVENT_COMMAND` 註解）。
    */
    `  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));`
      + `const g=(s.hooks||{})[process.argv[2]]||[];`
      + `for(const grp of g)for(const h of (grp.hooks||[]))process.stdout.write(Buffer.from(String(h.command),"utf8").toString("base64")+String.fromCharCode(10))' `
      + `"$settings" "$1" | { n=0; while IFS= read -r b64; do`,
    '    n=$((n+1))',
    '    cmd=$(printf %s "$b64" | base64 -d)',
    `    printf %s "$2" | sh -c "$cmd" > "${hookOutDir}/$1-$n" 2>/dev/null`,
    '  done; }',
    '}',
    'read_loop() {',
    '  stty -icanon min 1 time 0 < /dev/tty 2>/dev/null',
    '  line=""; nuser=0',
    '  while :; do',
    /*
      **A block at a time**: whatever the tty has, up to 4 KiB. Each block's arrival goes to the session's
      block receipt with its time, so a caller can tell "the submit key came as its own write, later" from
      "it came in the same write as the text" (`remote-protocol`'s split send). A per-byte timestamp would
      measure this loop's own pace (one `dd` per byte is about 2.5 ms), not the product's writes.
    */
    '    octs=$(dd bs=4096 count=1 2>/dev/null | od -An -v -to1 | tr -s " \\n" "  ")',
    '    [ -n "$(printf %s "$octs" | tr -d " ")" ] || break',
    `    printf '%s %s\\n' "$(date +%s%N)" "$octs" >> "${perSessionDir}/$sid.blocks"`,
    '    for oct in $octs; do',
    `    printf '%s ' "$oct" >> ${JSON.stringify(byteLog)}`,
    `    printf '%s ' "$oct" >> "${perSessionDir}/$sid.bytes"`,
    '    case "$oct" in',
    '      015|012) : ;;',
    '      *) line="$line$(printf "\\\\$oct")"; continue ;;',
    '    esac',
    dropFirstSubmit ? `    if [ ! -e "${perSessionDir}/$sid.dropped" ]; then : > "${perSessionDir}/$sid.dropped"; continue; fi` : '',
    `    printf '%s\\n' "$line" >> "${inputLog}"`,
    `    printf '%s\\n' "$line" >> "${perSessionDir}/$sid.lines"`,
    // The real agent reports every submitted prompt at once, before any record is written (measured,
    // CLI 2.1.300). Not an option: a probe that never sees it cannot show it was injected.
    '    fire UserPromptSubmit',
    modelSwitch
      ? [
          '    case "$line" in "/model "*)',
          '      req=$(printf %s "${line#/model }" | tr A-Z a-z)',
          '      for run in 1 2; do',
          `        firej PreModelSwitch "$(printf '{"hook_event_name":"PreModelSwitch","session_id":"%s","from_model":"claude-opus-5-5","to_model":"claude-haiku-5-5","requested_model":"%s","source":"command","prompt_cache_warm":true}' "$sid" "$req")"`,
          `        { cat "${hookOutDir}/PreModelSwitch-1"; printf '|'; } >> "${hookOutDir}/model-hook.log"`,
          '      done ;;',
          '    esac',
        ].join('\n')
      : '',
    // 延遲補寫紀錄 —— 用來驗「送出後在它出現於紀錄之前標示為未確認」。
    echoDelaySeconds ? `  sleep ${echoDelaySeconds}` : '',
    // Every record gets its own `uuid`: resuming a conversation names the last one received.
    '    nuser=$((nuser+1))',
    pasteWrap ? `    pre='\\n\\n<pasted_content id=\\"p1\\">\\n'; post='\\n</pasted_content id=\\"p1\\">\\n'` : '',
    '    content="$line"',
    slashCommands
      ? '    case "$line" in /*) cname="${line%% *}"; cargs=""; [ "$cname" = "$line" ] || cargs="${line#* }"; content="<command-message>${cname#/}</command-message>\\n<command-name>$cname</command-name>\\n<command-args>$cargs</command-args>" ;; esac'
      : '',
    queuedDelivery
      ? `    printf '{"type":"attachment","uuid":"q-%s-%s","timestamp":"2026-09-06T00:00:01.000Z","attachment":{"type":"queued_command","prompt":"%s","commandMode":"prompt","origin":{"kind":"human"}}}\\n' "$$" "$nuser" "$line" >> "$tp"`
      : pasteWrap
        ? `    printf '{"type":"user","uuid":"u-%s-%s","timestamp":"2026-09-06T00:00:01.000Z","message":{"role":"user","content":"%s%s%s"}}\\n' "$$" "$nuser" "$pre" "$line" "$post" >> "$tp"`
        : `    printf '{"type":"user","uuid":"u-%s-%s","timestamp":"2026-09-06T00:00:01.000Z","message":{"role":"user","content":"%s"}}\\n' "$$" "$nuser" "$content" >> "$tp"`,
    // `busySeconds`：先宣告忙碌、停一段時間再宣告就緒 —— 供「忙碌時呈現忙碌、閒置後消失」。
    busySeconds ? '  fire PreToolUse' : '',
    busySeconds ? `  sleep ${busySeconds}` : '',
    answerSeconds ? `  sleep ${answerSeconds}` : '',
    answerSeconds
      ? `  printf '{"type":"assistant","uuid":"ans-%s-%s","timestamp":"2026-09-06T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"STUB-ANSWER-%s"}]}}\\n' "$$" "$nuser" "$nuser" >> "$tp"`
      : '',
    /*
      `relocateAfterInput`：**換一份紀錄**，並以事件回報新的位置。

      這模擬的是使用者在 agent 之內清空或切換對話 —— 那些操作發生在 pty 之內，pty 沒死，
      spekterm 收不到任何自己發出的訊號。**唯一的線索就是事件帶來的 `transcript_path`。**
    */
    relocateAfterInput ? '  tp="$dir/relocated-$sid.jsonl"' : '',
    relocateAfterInput
      ? `  printf '{"type":"assistant","uuid":"r1","timestamp":"2026-09-06T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"RELOCATED-MARKER"}]}}\\n' >> "$tp"`
      : '',
    relocateAfterInput ? '  fire SessionEnd' : '',
    relocateAfterInput ? '  fire SessionStart' : '',
    // `holdPermission`：收到輸入後提出一個許可請求並**停在那裡**（不送 Stop）——
    // 模擬「agent 正在等使用者於終端回答」。
    holdPermission ? '  fire PermissionRequest' : '  fire Stop',
    '    line=""',
    '    done',
    '  done',
    '}',
    /*
      **讀取迴圈必須在就緒延遲之前就開始。**

      它原本排在 `fire SessionStart` 之後，於是提早抵達的位元組只是躺在 tty 緩衝區裡，
      要等迴圈起來才被讀到 —— **收據記的是「替身何時讀」，不是「產品何時寫」**，
      而「就緒之前不寫入」那條斷言因此對錯誤的實作照樣是綠的（對照組實測抓到）。

      以背景執行並在最後 `wait`：per-message 的補紀錄與 fire 全部留在迴圈裡，行為不變。
    */
    // **背景的是「延遲＋宣告就緒」，前景的是讀取迴圈。**
    //
    // 反過來（讀取迴圈丟到背景再 `wait`）會讓替身在 `dd` 一次空讀之後整個退出 ——
    // pty 隨之死亡，而畫面上分頁還在，症狀看起來像「產品沒有把 prompt 寫進去」。
    // 前景的阻塞讀取正是這支替身活著的理由。
    '(',
    readyDelaySeconds ? `sleep ${readyDelaySeconds}` : '',
    queryModes ? `printf '\\033[?2026$p\\033[?1016$p'` : '',
    'fire SessionStart',
    queryModes ? `printf '\\033[?2026$p'` : '',
    announceTitle ? `printf '\\033]0;%s\\007' ${JSON.stringify(announceTitle)}` : '',
    // 就緒的閘門 —— 判準的兩端都由檔案界定，呼叫端不必睡任何固定的時間。
    `date +%s%N > ${JSON.stringify(readyReceipt)}`,
    // 一則 agent 訊息 —— 讓「內容真的抵達對話 view」有東西可斷言。
    transcriptFixture
      ? `cat ${JSON.stringify(transcriptFixture)} > "$tp"`
      : `printf '{"type":"assistant","uuid":"a1","timestamp":"2026-09-06T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"STUB-HELLO-%s"}]}}\\n' "$sid" >> "$tp"`,
    skillListing ? listingLine(skillListing, true) : '',
    // 大量紀錄 —— 供「初次附掛超過上限時只送最近一段並明示」。
    bulkRecords
      ? `i=0; while [ $i -lt ${bulkRecords} ]; do printf '{"type":"assistant","uuid":"b%s","timestamp":"2026-09-06T00:00:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"BULK-%s"}]}}\\n' "$i" "$i" >> "$tp"; i=$((i+1)); done`
      : '',
    // 讀不到 —— 供「來源不可讀時明說，而非靜默呈現為沒有內容」。**在寫完之後才拿掉權限**，
    // 於是 `stat` 讀得到大小、`open` 卻失敗，正是那條 requirement 的情境。
    unreadable ? 'chmod 000 "$tp"' : '',
    startupStop ? 'fire Stop' : '',
    ') &',
    /*
      **探針下的指令**（`handoff-completion`）：`<commands>/<對話 id>.*` 出現就在**這個 shell 裡**執行它
      （於是 `fire` 可用），執行完刪掉。完成報告的時序只能這樣造：真實 agent 寫報告是一次工具呼叫
      （PreToolUse 在前），而「agent 已停下之後報告才被讀到」這個順序靠探針自己排。
      `$SPEKTERM_HANDOFF_DIR` 是產品交給 agent 的投遞落點 —— 與真實 agent 同一條路徑，不另外接。
    */
    `(while :; do for f in "${commandDir}/$sid".*; do [ -e "$f" ] || continue; . "$f"; rm -f "$f"; done; sleep 0.2; done) &`,
    /*
      讀 pty 的輸入。**逐位元組落盤，並自行組行** —— 每組成一行才補一則使用者訊息與一次 Stop。

      `-icanon` 讓 tty 立刻交出每一個位元組（預設的 canonical 模式要等換行）。
      `< /dev/tty` 不可省，理由同上面的 `stty size`。
      位元組以**八進位**記錄：控制位元組因此看得見，而 `printf '\\ooo'` 是 POSIX 的，
      轉回字元不需要外部工具。
    */
    // 前景的讀取迴圈是這支替身的主體 —— 它一直阻塞到 pty 關閉。
    'read_loop',
  ].filter(Boolean).join('\n')

  writeFileSync(join(bin, 'claude'), `${script}\n`)
  chmodSync(join(bin, 'claude'), 0o755)
  return {
    home,
    bin,
    /**
     * 某個 hook 事件上**第 n 條**命令的 stdout（n 自 1 起算）。
     *
     * 這是「注入的內容真的被交出去了」唯一的可觀察值 —— 設定檔裡有那條命令只證明我們寫了它。
     */
    hookStdout: (event, index = 1) => {
      try {
        return readFileSync(join(hookOutDir, `${event}-${index}`), 'utf8')
      } catch {
        return ''
      }
    },
    /** The `|`-separated stdout of every `PreModelSwitch` run (`modelSwitch`). */
    modelHookLog: () => {
      try {
        return readFileSync(join(hookOutDir, 'model-hook.log'), 'utf8')
      } catch {
        return ''
      }
    },
    /** 每一次啟動拿到的名字（`-` ＝ 沒有）。 */
    peerNames: () => {
      try {
        return readFileSync(nameLog, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [conversation, argv, env] = line.split('\t')
            return { conversation, argv, env }
          })
      } catch {
        return []
      }
    },
    /** 某個事件上被執行的命令條數。 */
    hookCommandCount: (event) => {
      try {
        return readdirSync(hookOutDir).filter((name) => name.startsWith(`${event}-`)).length
      } catch {
        return 0
      }
    },
    cols: () => Number(readFileSync(sizeReceipt, 'utf8').trim().split(/\s+/)[1] ?? 0),
    input: () => {
      try {
        return readFileSync(inputLog, 'utf8')
      } catch {
        return ''
      }
    },
    /**
     * 逐位元組的收據，還原成文字。
     *
     * **這是唯一看得見「不附送出字元的寫入」的管道** —— `input()` 要等行終止字元才落盤。
     */
    bytes: () => {
      let raw
      try {
        raw = readFileSync(byteLog, 'utf8')
      } catch {
        return ''
      }
      return raw
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((oct) => String.fromCharCode(parseInt(oct, 8)))
        .join('')
    },
    /**
     * 每個 session（以對話 id 為鍵）收到的輸入：組成的行、以及逐位元組還原的文字。
     * 見 `perSessionDir` 的註解 —— 判定「送到哪一個 session」只能用這一份。
     */
    sessionInputs: () => {
      const result = {}
      let names
      try {
        names = readdirSync(perSessionDir)
      } catch {
        return result
      }
      for (const name of names) {
        const match = name.match(/^(.+)\.(bytes|lines)$/)
        if (!match) continue
        const entry = (result[match[1]] ??= { lines: [], bytes: '' })
        const text = readFileSync(join(perSessionDir, name), 'utf8')
        if (match[2] === 'lines') entry.lines = text.split('\n').filter(Boolean)
        else
          entry.bytes = text
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map((oct) => String.fromCharCode(parseInt(oct, 8)))
            .join('')
      }
      return result
    },
    /**
     * 叫某個 session（以對話 id 指定）的替身執行一段 shell（`fire <事件>` 可用）。
     * 以原子改名投遞，替身不會讀到寫到一半的指令。
     */
    command: (conversationId, script) => {
      const seq = ++commandSeq
      const final = join(commandDir, `${conversationId}.${seq}`)
      // 暫存名以點開頭 —— 替身的 glob（`<id>.*`）碰不到它，不會讀到寫到一半的指令。
      const staging = join(commandDir, `.staging-${conversationId}-${seq}`)
      writeFileSync(staging, `${script}\n`)
      renameSync(staging, final)
    },
    /**
     * 完成報告（`handoff-completion`）的 shell 片段，寫到**該 session 自己的**投遞落點
     * （`$SPEKTERM_HANDOFF_DIR`，產品交給 agent 的那一個）。
     *
     * `stage` 寫成以點開頭的暫存名（產品不讀它），`commit` 才改名成 `.json` —— 兩者分開，呼叫端才排得出
     * 「agent 已停下之後報告才被讀到」的順序。`write` ＝ 兩者連續。事件（`fire …`）由呼叫端自己排。
     */
    report: {
      stage: (summary) => {
        const payload = JSON.stringify({ kind: 'report', summary }).replace(/'/g, "'\\''")
        return `printf '%s' '${payload}' > "$SPEKTERM_HANDOFF_DIR/.report.partial"`
      },
      commit: () => 'mv "$SPEKTERM_HANDOFF_DIR/.report.partial" "$SPEKTERM_HANDOFF_DIR/report-$(date +%s%N).json"',
    },
    /**
     * A session command (`agent-session-control`), written into **that session's own** drop point like a report:
     * `stage` writes a dot-named staging file the product does not read, `commit` renames it into place.
     */
    control: {
      stage: (payload) => {
        const json = JSON.stringify(payload).replace(/'/g, "'\\''")
        return `printf '%s' '${json}' > "$SPEKTERM_HANDOFF_DIR/.control.partial"`
      },
      commit: () => 'mv "$SPEKTERM_HANDOFF_DIR/.control.partial" "$SPEKTERM_HANDOFF_DIR/control-$(date +%s%N).json"',
    },
    /**
     * The blocks one session's stub read, in order: `{ atMs, text }`. `atMs` is when the block arrived
     * (milliseconds, fractional). See the read loop: one block is one read of whatever the tty held.
     */
    sessionBlocks: (conversationId) => {
      let raw
      try {
        raw = readFileSync(join(perSessionDir, `${conversationId}.blocks`), 'utf8')
      } catch {
        return []
      }
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [ns, ...octs] = line.trim().split(/\s+/)
          return {
            atMs: Number(BigInt(ns) / 1000n) / 1000,
            text: octs.map((oct) => String.fromCharCode(parseInt(oct, 8))).join(''),
          }
        })
    },
    /** A probe command appending a later `skill_listing` record (`command(conversationId, …)`). */
    skillListing: (names, isInitial = false) => listingLine(names, isInitial),
    /**
     * A probe command running the status line command the product injected (`--settings`), with this payload on
     * stdin, as the agent does when it redraws its status line. The stub does not run it by itself.
     */
    statusLine: (payload) =>
      `cmd=$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String((s.statusLine||{}).command||""))' "$settings"); ` +
      `[ -z "$cmd" ] || printf '%s' '${JSON.stringify(payload).replace(/'/g, "'\\''")}' | sh -c "$cmd" >/dev/null 2>&1`,
    /** 替身宣告就緒的那一刻是否已經到了。 */
    ready: () => existsSync(readyReceipt),
  }
}
