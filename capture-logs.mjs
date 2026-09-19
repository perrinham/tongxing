import { chromium } from '/Users/a1111/.workbuddy/binaries/node/versions/22.22.2-2/lib/node_modules/agent-browser/node_modules/playwright-core/index.mjs'

const browser = await chromium.launch({
  executablePath:
    '/Users/a1111/.agent-browser/browsers/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: ['--no-sandbox', '--no-proxy-server']
})

const page = await browser.newPage()
const logs = []
page.on('console', (msg) => logs.push({ type: msg.type(), text: msg.text() }))
page.on('pageerror', (err) => logs.push({ type: 'pageerror', text: err.message }))
page.on('requestfailed', (req) => logs.push({ type: 'requestfailed', text: `${req.url()} ${req.failure()?.errorText || ''}` }))

await page.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 10000 })
await page.waitForTimeout(2500)

console.log('--- logs ---')
logs.forEach((l) => console.log(`[${l.type}] ${l.text}`))
console.log('--- app html ---')
const html = await page.content()
console.log(html.slice(0, 1200))

await browser.close()
