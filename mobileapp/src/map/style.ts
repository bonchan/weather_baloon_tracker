import { layers, namedFlavor } from '@protomaps/basemaps'
import type { LayerSpecification, StyleSpecification } from '@maplibre/maplibre-react-native'
import type { Lang } from '../i18n'

/** Same OpenStreetMap vector tiles as the web app; MapLibre Native reads PMTiles over HTTP range requests. */
const TILES = 'pmtiles://https://data.source.coop/protomaps/openstreetmap/v4.pmtiles'
// Online for now; offline area downloads come next (see README).
const ASSETS = 'https://protomaps.github.io/basemaps-assets'

export function mapStyle(lang: Lang): StyleSpecification {
  return {
    version: 8,
    glyphs: `${ASSETS}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${ASSETS}/sprites/v4/dark`,
    sources: {
      protomaps: {
        type: 'vector',
        url: TILES,
        attribution: '© OpenStreetMap · Protomaps',
      },
    },
    layers: layers('protomaps', namedFlavor('dark'), { lang }) as LayerSpecification[],
  }
}
