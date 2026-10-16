/**
 * desktop-packaging：桌面整合的安裝與移除。
 *
 * ## 為什麼這一整支跑得起來
 *
 * 因為路徑全部經 `HOME` / `XDG_*` 解析（design D6）。**那不是可攜性的裝飾，是驗收的前提** ——
 * 寫死 `~/.local/share` 的話，這六條 scenario 就只剩人工驗收，而它們每一條都在秒級可驗。
 *
 * ## fixture 必須是真的 ELF 執行檔
 *
 * 〈已安裝的產物正在執行時仍可換版〉靠的是 `ETXTBSY`，而**那只對被 mmap 的原生執行檔發生**。
 * 用 shell script 當 fixture 時就地覆寫會**成功**（實測），於是對照組沒有鑑別力 —— 一個用
 * `copyFileSync` 就地覆寫的實作會全綠。因此借用系統的 `/bin/sleep` 與 `/bin/true`。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { installDesktop } from './install-desktop.mjs'
import { uninstallDesktop } from './uninstall-desktop.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 一個把 HOME / XDG_* 指到暫存目錄的環境，以及一份假的 repo 根（package.json ＋ build/icon.png）。 */
function makeSandbox() {
  const home = mkdtempSync(join(tmpdir(), 'spekterm-desktop-'))
  const env = {
    HOME: home,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_BIN_HOME: join(home, '.local', 'bin'),
  }
  const fakeRepo = join(home, 'repo')
  mkdirSync(join(fakeRepo, 'build'), { recursive: true })
  mkdirSync(join(fakeRepo, 'release'), { recursive: true })
  writeFileSync(join(fakeRepo, 'package.json'), JSON.stringify({ version: '0.1.0' }))
  copyFileSync(join(repoRoot, 'build', 'icon.png'), join(fakeRepo, 'build', 'icon.png'))
  return { home, env, fakeRepo, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

/** 造一份**真 ELF** 的假產物（見檔頭）。 */
function fakeArtifact(dir, name, from = '/bin/true') {
  const target = join(dir, name)
  copyFileSync(from, target)
  return target
}

const entryField = (path, key) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1)

test('安裝後桌面項目存在且指向已安裝的產物', () => {
  const { env, fakeRepo, cleanup } = makeSandbox()
  try {
    const source = fakeArtifact(join(fakeRepo, 'release'), 'Spekterm-0.1.0.AppImage')
    const paths = installDesktop({ repoRoot: fakeRepo, env, source })

    assert.ok(existsSync(paths.entry), '.desktop 應存在')
    const exec = entryField(paths.entry, 'Exec')
    assert.equal(exec, paths.binary)
    assert.ok(existsSync(exec), 'Exec 指向的檔案必須實際存在')
    accessSync(exec, constants.X_OK) // 且可執行

    // 指向一個不存在的圖示時，選單只會安靜地顯示預設齒輪 —— 沒有任何訊息。
    const icon = entryField(paths.entry, 'Icon')
    assert.ok(existsSync(icon), 'Icon 指向的檔案必須實際存在')

    // 執行中的視窗要與選單圖示歸為一組。
    assert.equal(entryField(paths.entry, 'StartupWMClass'), 'spekterm')
  } finally {
    cleanup()
  }
})

test('桌面項目的執行目標不隨版本改變', () => {
  const { env, fakeRepo, cleanup } = makeSandbox()
  try {
    // **兩個檔名不同的來源產物** —— 同名的話這條沒有鑑別力。
    const a = fakeArtifact(join(fakeRepo, 'release'), 'Spekterm-0.1.0.AppImage')
    const b = fakeArtifact(join(fakeRepo, 'release'), 'Spekterm-0.2.0.AppImage', '/bin/sleep')

    const first = installDesktop({ repoRoot: fakeRepo, env, source: a })
    const firstExec = entryField(first.entry, 'Exec')
    const second = installDesktop({ repoRoot: fakeRepo, env, source: b })
    const secondExec = entryField(second.entry, 'Exec')

    assert.equal(firstExec, secondExec, '換版不得需要重寫桌面項目')
  } finally {
    cleanup()
  }
})

/**
 * **這條在結構上不可能紅。** 安裝的三個路徑都是固定檔名（design D6），寫兩次不可能產生兩個項目
 * —— 它記錄的是一個**結構性保證**，不是一條有鑑別力的斷言。留著是為了讓「檔名改成帶版本」
 * 這種改動有東西擋，但它不得被計入「抓得到 bug 的覆蓋」。
 */
test('重複安裝不產生重複的項目', () => {
  const { env, fakeRepo, cleanup } = makeSandbox()
  try {
    const source = fakeArtifact(join(fakeRepo, 'release'), 'Spekterm-0.1.0.AppImage')
    installDesktop({ repoRoot: fakeRepo, env, source })
    installDesktop({ repoRoot: fakeRepo, env, source })

    const entries = readdirSync(join(env.XDG_DATA_HOME, 'applications'))
    assert.deepEqual(entries, ['spekterm.desktop'])
    // 暫存檔不得殘留 —— 安裝走「暫存名 ＋ rename」，中途留下 `.installing` 是實作漏了收尾。
    assert.deepEqual(readdirSync(env.XDG_BIN_HOME), ['Spekterm.AppImage'])
  } finally {
    cleanup()
  }
})

test('提供移除方式', () => {
  const { env, fakeRepo, cleanup } = makeSandbox()
  try {
    const source = fakeArtifact(join(fakeRepo, 'release'), 'Spekterm-0.1.0.AppImage')
    const paths = installDesktop({ repoRoot: fakeRepo, env, source })
    uninstallDesktop(env)
    for (const target of Object.values(paths)) {
      assert.equal(existsSync(target), false, `${target} 應已被移除`)
    }
  } finally {
    cleanup()
  }
})

test('產物不存在時明確失敗，且不寫任何檔案', () => {
  const { env, fakeRepo, cleanup } = makeSandbox()
  try {
    assert.throws(
      () => installDesktop({ repoRoot: fakeRepo, env, source: join(fakeRepo, 'release', 'nope.AppImage') }),
      /找不到打包產物/,
    )
    // 一個指向不存在檔案的桌面項目，比失敗更難診斷。
    assert.equal(existsSync(join(env.XDG_DATA_HOME, 'applications', 'spekterm.desktop')), false)
  } finally {
    cleanup()
  }
})

test('已安裝的產物正在執行時仍可換版', async () => {
  const { env, fakeRepo, cleanup } = makeSandbox()
  try {
    const sleeper = fakeArtifact(join(fakeRepo, 'release'), 'Spekterm-0.1.0.AppImage', '/bin/sleep')
    const paths = installDesktop({ repoRoot: fakeRepo, env, source: sleeper })

    const running = spawn(paths.binary, ['30'], { stdio: 'ignore' })
    await new Promise((resolve) => running.once('spawn', resolve))
    try {
      // 對照組：就地覆寫在這個狀態下必須失敗，否則這條測不到任何東西。
      assert.throws(() => copyFileSync('/bin/true', paths.binary), (error) =>
        error.code === 'ETXTBSY' || error.code === 'EBUSY')

      const next = fakeArtifact(join(fakeRepo, 'release'), 'Spekterm-0.2.0.AppImage')
      installDesktop({ repoRoot: fakeRepo, env, source: next })
      assert.equal(running.killed, false, '既有行程不得被安裝影響')
    } finally {
      running.kill()
    }
  } finally {
    cleanup()
  }
})

test('安裝的是獨立副本 —— 來源被清除後仍可執行', () => {
  const { env, fakeRepo, cleanup } = makeSandbox()
  try {
    const source = fakeArtifact(join(fakeRepo, 'release'), 'Spekterm-0.1.0.AppImage')
    const paths = installDesktop({ repoRoot: fakeRepo, env, source })

    rmSync(join(fakeRepo, 'release'), { recursive: true, force: true })
    assert.ok(existsSync(paths.binary))
    accessSync(paths.binary, constants.X_OK)
    // **「應用程式視窗成功開啟」不由這條承擔** —— 那半由 dogfood 認定（tasks 8.4）。
  } finally {
    cleanup()
  }
})
