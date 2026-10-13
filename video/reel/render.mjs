/* global process, console, window, render */
// Renders index.html frame by frame: `node render.mjs stills <t>...` writes preview JPEGs,
// `node render.mjs <out.mp4>` pipes all frames to ffmpeg. Playwright is resolved from the
// current project unless PLAYWRIGHT_MODULE points at another install.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pw = process.env.PLAYWRIGHT_MODULE ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE, 'index.mjs')).href : 'playwright'
const { chromium } = await import(pw)
const here = path.dirname(fileURLToPath(import.meta.url))
process.chdir(here)
;(async () => {
  const mode = process.argv[2] || 'stills';
  const browser = await chromium.launch({ args: ['--disable-web-security', '--allow-file-access-from-files'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('console', m => console.log('page:', m.text()));
  page.on('pageerror', e => console.log('ERR', e.message));
  await page.goto('file://' + path.resolve('index.html'));
  await page.evaluate(() => window.ready);
  if (mode === 'stills') {
    const ts = process.argv.slice(3).map(Number);
    for (const t of ts) { await page.evaluate(t => render(t), t); await page.screenshot({ path: `still-${t}.jpg`, type: 'jpeg', quality: 85 }); }
  } else {
    const fps = 30, N = 60 * fps;
    const ff = spawn('ffmpeg', ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mode], { stdio: ['pipe', 'inherit', 'inherit'] });
    for (let f = 0; f < N; f++) {
      await page.evaluate(t => render(t), f / fps);
      const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
      if (f % 90 === 0) console.log('frame', f);
    }
    ff.stdin.end(); await new Promise(r => ff.on('close', r));
  }
  await browser.close();
})();

