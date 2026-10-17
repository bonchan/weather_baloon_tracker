// Downloads the fonts (glyph PBFs) and icon sprites the offline basemap style needs
// into public/map-assets, so the map renders with no internet. Run once: pnpm map:assets
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'https://protomaps.github.io/basemaps-assets'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'map-assets')

const FONTS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic']
// Latin, Latin-1, Latin Extended A/B, Latin Extended Additional, punctuation: enough for Spanish and English.
const RANGES = ['0-255', '256-511', '512-767', '7680-7935', '8192-8447']
const SPRITES = ['dark.json', 'dark.png', 'dark@2x.json', 'dark@2x.png']

async function download(url, path) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.from(await res.arrayBuffer()))
  console.log(`✓ ${path.slice(OUT.length + 1)}`)
}

const jobs = []
for (const font of FONTS) {
  for (const range of RANGES) {
    jobs.push(download(`${BASE}/fonts/${encodeURIComponent(font)}/${range}.pbf`, join(OUT, 'fonts', font, `${range}.pbf`)))
  }
}
for (const sprite of SPRITES) {
  jobs.push(download(`${BASE}/sprites/v4/${sprite}`, join(OUT, 'sprites', sprite)))
}
await Promise.all(jobs)
console.log('Map assets ready.')
