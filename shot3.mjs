import { chromium } from 'playwright'
import { authenticator } from 'otplib'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const ctx = await b.newContext({ viewport: { width: 1440, height: 940 }, colorScheme: 'light' })
const p = await ctx.newPage()
p.on('console', m => m.type() === 'error' && console.log('console error:', m.text()))

await p.goto('http://localhost:5174/', { waitUntil: 'networkidle' })
await p.screenshot({ path: '/tmp/admin-login.png' })

await p.fill('input[type=email]', 'truckingoutlaws@outlook.com')
await p.fill('input[type=password]', 'dev-only-change-me-now')
await p.fill('input[inputmode=numeric]', authenticator.generate('ERTCWLRLNZVRWJZ2'))
await p.click('button[type=submit]')
await p.waitForTimeout(2500)
await p.screenshot({ path: '/tmp/admin-overview.png', fullPage: true })

for (const [name, path] of [['tenants','/tenants'], ['abuse','/abuse'], ['plans','/plans'], ['system','/system'], ['audit','/audit'], ['pools','/pools']]) {
  await p.goto(`http://localhost:5174${path}`, { waitUntil: 'networkidle' })
  await p.waitForTimeout(800)
  await p.screenshot({ path: `/tmp/admin-${name}.png`, fullPage: true })
}

// Tenant detail
await p.goto('http://localhost:5174/tenants', { waitUntil: 'networkidle' })
await p.waitForTimeout(700)
const link = await p.$('tbody a')
if (link) { await link.click(); await p.waitForTimeout(1400); await p.screenshot({ path: '/tmp/admin-tenant.png', fullPage: true }) }

await b.close()
console.log('ok')
