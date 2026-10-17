import { layers, namedFlavor } from '@protomaps/basemaps'
import type { Feature, FeatureCollection } from 'geojson'
import {
  addProtocol,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
  type MapOptions,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre finds its worker next to its own file, which Vite pre-bundling breaks; hand it a bundled copy.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { Protocol } from 'pmtiles'
import { useEffect, useRef, useState } from 'react'
import { useI18n, type Lang } from '../i18n'
import { DEFAULT_LAUNCH } from '../sonde/demo'
import { sondes, useSondes, type SondeState } from '../sonde/store'
import { SondeInfo } from './SondeInfo'

/** Offline basemap: a Protomaps .pmtiles extract you drop into public/maps. */
const BASEMAP_URL = '/maps/basemap.pmtiles'

type StyleSpecification = Exclude<MapOptions['style'], string | undefined>
type LayerSpecification = StyleSpecification['layers'][number]

let initialized = false
function initMapLibre() {
  if (initialized) return
  setWorkerUrl(maplibreWorkerUrl)
  addProtocol('pmtiles', new Protocol().tile)
  initialized = true
}

/** True when the extract exists; the dev server answers missing files with index.html, so check the magic bytes. */
async function basemapAvailable(): Promise<boolean> {
  try {
    const res = await fetch(BASEMAP_URL, { headers: { Range: 'bytes=0-6' } })
    if (!res.ok) return false
    return new TextDecoder().decode((await res.arrayBuffer()).slice(0, 7)) === 'PMTiles'
  } catch {
    return false
  }
}

function buildStyle(withBasemap: boolean, lang: Lang): StyleSpecification {
  const origin = window.location.origin
  return {
    version: 8,
    glyphs: `${origin}/map-assets/fonts/{fontstack}/{range}.pbf`,
    sprite: `${origin}/map-assets/sprites/dark`,
    sources: withBasemap
      ? {
          protomaps: {
            type: 'vector',
            url: `pmtiles://${origin}${BASEMAP_URL}`,
            attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> · Protomaps',
          },
        }
      : {},
    layers: withBasemap
      ? (layers('protomaps', namedFlavor('dark'), { lang }) as LayerSpecification[])
      : [{ id: 'background', type: 'background', paint: { 'background-color': '#0b1220' } }],
  }
}

type Collection = FeatureCollection

function tracksGeoJson(state: SondeState): Collection {
  return {
    type: 'FeatureCollection',
    features: Object.values(state.tracks).map((t) => ({
      type: 'Feature',
      properties: { serial: t.serial, active: t.serial === state.active },
      geometry: { type: 'LineString', coordinates: t.fixes.map((f) => [f.lon, f.lat]) },
    })),
  }
}

function sondesGeoJson(state: SondeState): Collection {
  return {
    type: 'FeatureCollection',
    features: Object.values(state.tracks).map((t) => {
      const last = t.fixes[t.fixes.length - 1]
      return {
        type: 'Feature',
        properties: { label: `${t.serial}\n${Math.round(last.alt)} m`, active: t.serial === state.active },
        geometry: { type: 'Point', coordinates: [last.lon, last.lat] },
      }
    }),
  }
}

function stationGeoJson(state: SondeState, label: string): Collection {
  const s = state.station
  const active = state.active ? state.tracks[state.active] : undefined
  const last = active?.fixes[active.fixes.length - 1]
  const features: Feature[] = []
  if (s) {
    features.push({ type: 'Feature', properties: { label }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })
    if (last) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [[s.lon, s.lat], [last.lon, last.lat]] },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

function addOverlays(map: MapLibreMap) {
  const empty: Collection = { type: 'FeatureCollection', features: [] }
  map.addSource('tracks', { type: 'geojson', data: empty })
  map.addSource('sondes', { type: 'geojson', data: empty })
  map.addSource('station', { type: 'geojson', data: empty })
  map.addLayer({
    id: 'station-link',
    type: 'line',
    source: 'station',
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': '#ffffff', 'line-opacity': 0.35, 'line-width': 1.2, 'line-dasharray': [3, 3] },
  })
  map.addLayer({
    id: 'tracks',
    type: 'line',
    source: 'tracks',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['case', ['get', 'active'], '#5cc8ff', '#7d8da3'],
      'line-width': ['case', ['get', 'active'], 3, 2],
    },
  })
  map.addLayer({
    id: 'station',
    type: 'circle',
    source: 'station',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 6, 'circle-color': '#3fd18b', 'circle-stroke-width': 2, 'circle-stroke-color': '#0a0e14' },
  })
  map.addLayer({
    id: 'sondes',
    type: 'circle',
    source: 'sondes',
    paint: {
      'circle-radius': ['case', ['get', 'active'], 7, 5],
      'circle-color': '#ff7ad9',
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
    },
  })
  const label = {
    'text-font': ['Noto Sans Medium'],
    'text-size': 12,
    'text-anchor': 'left' as const,
    'text-offset': [1, 0] as [number, number],
    'text-allow-overlap': true,
  }
  const halo = { 'text-color': '#e4ebf3', 'text-halo-color': '#0a0e14', 'text-halo-width': 1.5 }
  map.addLayer({ id: 'sonde-labels', type: 'symbol', source: 'sondes', layout: { ...label, 'text-field': ['get', 'label'] }, paint: halo })
  map.addLayer({
    id: 'station-label',
    type: 'symbol',
    source: 'station',
    filter: ['==', ['geometry-type'], 'Point'],
    layout: { ...label, 'text-field': ['get', 'label'] },
    paint: halo,
  })
}

type MapCanvasProps = {
  withBasemap: boolean
  lang: Lang
  placingStation: boolean
  onStationPlaced: () => void
  follow: boolean
  visible: boolean
}

/** The MapLibre map itself. Remounted when the language changes so labels switch too. */
function MapCanvas({ withBasemap, lang, placingStation, onStationPlaced, follow, visible }: MapCanvasProps) {
  const { t } = useI18n()
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  // The map instance that has finished loading; a remount (language change) must wait for its own load.
  const [loadedMap, setLoadedMap] = useState<MapLibreMap | null>(null)
  const state = useSondes()
  // The map is created once; its click handler reads the latest props through refs.
  const placingRef = useRef(placingStation)
  const placedRef = useRef(onStationPlaced)
  useEffect(() => {
    placingRef.current = placingStation
    placedRef.current = onStationPlaced
  })

  useEffect(() => {
    initMapLibre()
    const initial = sondes.getState().station ?? DEFAULT_LAUNCH
    const map = new MapLibreMap({
      container: container.current!,
      style: buildStyle(withBasemap, lang),
      center: [initial.lon, initial.lat],
      zoom: 8,
      attributionControl: { compact: true },
    })
    map.addControl(new NavigationControl({ visualizePitch: false }), 'top-right')
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left')
    map.on('load', () => {
      addOverlays(map)
      setLoadedMap(map)
    })
    map.on('click', (e) => {
      if (!placingRef.current) return
      const prev = sondes.getState().station
      sondes.setStation({ lat: e.lngLat.lat, lon: e.lngLat.lng, alt: prev?.alt ?? DEFAULT_LAUNCH.alt })
      placedRef.current()
    })
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [withBasemap, lang])

  useEffect(() => {
    const map = loadedMap
    if (!map || map !== mapRef.current) return
    ;(map.getSource('tracks') as GeoJSONSource).setData(tracksGeoJson(state))
    ;(map.getSource('sondes') as GeoJSONSource).setData(sondesGeoJson(state))
    ;(map.getSource('station') as GeoJSONSource).setData(stationGeoJson(state, t('map.station')))
  }, [state, loadedMap, t])

  const active = state.active ? state.tracks[state.active] : undefined
  const last = active?.fixes[active.fixes.length - 1]
  useEffect(() => {
    if (follow && last && mapRef.current) mapRef.current.easeTo({ center: [last.lon, last.lat], duration: 300 })
  }, [follow, last])

  useEffect(() => {
    if (visible) mapRef.current?.resize()
  }, [visible])

  return <div ref={container} className={`map-canvas ${placingStation ? 'placing' : ''}`} />
}

export default function MapView({ visible }: { visible: boolean }) {
  const { t, lang } = useI18n()
  const [basemap, setBasemap] = useState<'checking' | 'yes' | 'no'>('checking')
  const [placingStation, setPlacingStation] = useState(false)
  const [follow, setFollow] = useState(true)

  useEffect(() => {
    void basemapAvailable().then((ok) => setBasemap(ok ? 'yes' : 'no'))
  }, [])

  return (
    <div className="map-view">
      {basemap === 'checking' ? (
        <div className="spectrum-empty">{t('map.loading')}</div>
      ) : (
        <MapCanvas
          withBasemap={basemap === 'yes'}
          lang={lang}
          placingStation={placingStation}
          onStationPlaced={() => setPlacingStation(false)}
          follow={follow}
          visible={visible}
        />
      )}
      <SondeInfo
        placingStation={placingStation}
        onPlaceStation={() => setPlacingStation((p) => !p)}
        follow={follow}
        onFollow={setFollow}
      />
      {basemap === 'no' && (
        <div className="map-notice callout">
          <strong>{t('map.noBasemap')}</strong>
          <p className="small">{t('map.noBasemapHelp')}</p>
        </div>
      )}
    </div>
  )
}
