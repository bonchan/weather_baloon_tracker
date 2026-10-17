// Writes the MapLibre style the Android app bundles (app/src/main/assets/map/), using the same
// Protomaps basemap package as the web app, and copies the web app's fonts and icons next to it.
// Run from android/ after `pnpm install` in webapp/:  node scripts/generate-map-style.mjs
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const out = join(here, '..', 'app', 'src', 'main', 'assets', 'map')
const basemaps = await import(pathToFileURL(join(repo, 'webapp', 'node_modules', '@protomaps', 'basemaps', 'dist', 'esm', 'index.js')).href)

// OpenStreetMap vector tiles from the public Protomaps planet build; MapLibre Native reads PMTiles over HTTP.
const TILES = 'pmtiles://https://data.source.coop/protomaps/openstreetmap/v4.pmtiles'

mkdirSync(out, { recursive: true })
for (const lang of ['es', 'en']) {
  const style = {
    version: 8,
    // asset:// keeps labels and icons working with no internet.
    glyphs: 'asset://map/fonts/{fontstack}/{range}.pbf',
    sprite: 'asset://map/sprites/dark',
    sources: {
      protomaps: { type: 'vector', url: TILES, attribution: '© OpenStreetMap · Protomaps' },
    },
    layers: basemaps.layers('protomaps', basemaps.namedFlavor('dark'), { lang }),
  }
  writeFileSync(join(out, `style-dark-${lang}.json`), JSON.stringify(style))
}
cpSync(join(repo, 'webapp', 'public', 'map-assets', 'fonts'), join(out, 'fonts'), { recursive: true })
cpSync(join(repo, 'webapp', 'public', 'map-assets', 'sprites'), join(out, 'sprites'), { recursive: true })
console.log(`Map style and assets written to ${out}`)
