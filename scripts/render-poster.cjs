const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  const file = 'file://' + path.resolve(__dirname, 'poster.html');
  await page.goto(file, { waitUntil: 'networkidle' });
  const stage = await page.$('.stage');
  const out = path.resolve(__dirname, '..', 'resources', 'poster.png');
  await stage.screenshot({ path: out });
  console.log('saved ->', out);
  await browser.close();
})();
