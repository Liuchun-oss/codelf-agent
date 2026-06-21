import { writeFileSync, copyFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const png = resolve(root, 'resources/icon.png')
const assets = resolve(root, 'src/assets/app-icon.png')
const ico = resolve(root, 'resources/icon.ico')
const icns = resolve(root, 'resources/icon.icns')

// Codelf = Code + elf: two code brackets framing a tilted magic wand.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6366F1"/>
      <stop offset="1" stop-color="#A855F7"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="58" fill="url(#bg)"/>
  <g fill="none" stroke="#FFFFFF" stroke-width="15" stroke-linecap="round" stroke-linejoin="round" opacity="0.95">
    <polyline points="92,104 60,134 92,164"/>
    <polyline points="164,104 196,134 164,164"/>
  </g>
  <g fill="#FFFFFF">
    <line x1="108" y1="172" x2="146" y2="104" stroke="#FFFFFF" stroke-width="16" stroke-linecap="round"/>
    <path d="M150 70 Q150 92 172 92 Q150 92 150 114 Q150 92 128 92 Q150 92 150 70 Z"/>
    <circle cx="104" cy="92" r="6"/>
    <circle cx="120" cy="150" r="5"/>
  </g>
</svg>`

const sizes = [256, 128, 64, 48, 32, 16]

mkdirSync(dirname(assets), { recursive: true })

async function render(size) {
  return sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()
}

const main = await render(256)
writeFileSync(png, main)
copyFileSync(png, assets)

const buffers = await Promise.all(sizes.map(render))
const icoBuf = await pngToIco(buffers)
writeFileSync(ico, icoBuf)

// macOS .icns: a magic header followed by typed PNG entries (8-byte header per entry).
const icnsEntries = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024]
]

function icnsBlock(osType, png) {
  const header = Buffer.alloc(8)
  header.write(osType, 0, 'ascii')
  header.writeUInt32BE(png.length + 8, 4)
  return Buffer.concat([header, png])
}

const icnsBlocks = await Promise.all(
  icnsEntries.map(async ([osType, size]) => icnsBlock(osType, await render(size)))
)
const body = Buffer.concat(icnsBlocks)
const icnsHeader = Buffer.alloc(8)
icnsHeader.write('icns', 0, 'ascii')
icnsHeader.writeUInt32BE(body.length + 8, 4)
const icnsBuf = Buffer.concat([icnsHeader, body])
writeFileSync(icns, icnsBuf)

console.log(`icon.png 256x256, ico ${icoBuf.length} bytes (${sizes.join('/')}), icns ${icnsBuf.length} bytes`)
