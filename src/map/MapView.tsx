import { layers, namedFlavor } from '@protomaps/basemaps'
import type { Feature, FeatureCollection } from 'geojson'
import {
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
import { useEffect, useRef, useState } from 'react'
import { useI18n, type Lang } from '../i18n'
import { DEFAULT_LAUNCH } from '../sonde/demo'
import { sondes, useSondes, type SondeState } from '../sonde/store'
import { OfflineMapPanel } from './OfflineMapPanel'
import { SondeInfo } from './SondeInfo'
import type { Bounds } from './tileMath'
import { registerTileProtocol, SOURCE_MAX_ZOOM, TILE_URL_TEMPLATE } from './tiles'

type StyleSpecification = Exclude<MapOptions['style'], string | undefined>
type LayerSpecification = StyleSpecification['layers'][number]

let initialized = false
function initMapLibre() {
  if (initialized) return
  setWorkerUrl(maplibreWorkerUrl)
  registerTileProtocol()
  initialized = true
}

function buildStyle(lang: Lang): StyleSpecification {
  const origin = window.location.origin
  return {
    version: 8,
    glyphs: `${origin}/map-assets/fonts/{fontstack}/{range}.pbf`,
    sprite: `${origin}/map-assets/sprites/dark`,
    sources: {
      protomaps: {
        type: 'vector',
        tiles: [TILE_URL_TEMPLATE],
        maxzoom: SOURCE_MAX_ZOOM,
        attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> · Protomaps',
      },
    },
    layers: layers('protomaps', namedFlavor('dark'), { lang }) as LayerSpecification[],
  }
}

function tracksGeoJson(state: SondeState): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: Object.values(state.tracks).map((t) => ({
      type: 'Feature',
      properties: { serial: t.serial, active: t.serial === state.active },
      geometry: { type: 'LineString', coordinates: t.fixes.map((f) => [f.lon, f.lat]) },
    })),
  }
}

function sondesGeoJson(state: SondeState): FeatureCollection {
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

function stationGeoJson(state: SondeState, label: string): FeatureCollection {
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
  const empty: FeatureCollection = { type: 'FeatureCollection', features: [] }
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
  lang: Lang
  placingStation: boolean
  onStationPlaced: () => void
  follow: boolean
  visible: boolean
  onViewChange: (bounds: Bounds) => void
}

/** The MapLibre map itself. Remounted when the language changes so labels switch too. */
function MapCanvas({ lang, placingStation, onStationPlaced, follow, visible, onViewChange }: MapCanvasProps) {
  const { t } = useI18n()
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  // The map instance that has finished loading; a remount (language change) must wait for its own load.
  const [loadedMap, setLoadedMap] = useState<MapLibreMap | null>(null)
  const state = useSondes()
  // The map is created once; its handlers read the latest props through refs.
  const placingRef = useRef(placingStation)
  const placedRef = useRef(onStationPlaced)
  const viewRef = useRef(onViewChange)
  useEffect(() => {
    placingRef.current = placingStation
    placedRef.current = onStationPlaced
    viewRef.current = onViewChange
  })

  useEffect(() => {
    initMapLibre()
    const initial = sondes.getState().station ?? DEFAULT_LAUNCH
    const map = new MapLibreMap({
      container: container.current!,
      style: buildStyle(lang),
      center: [initial.lon, initial.lat],
      zoom: 8,
      attributionControl: { compact: true },
    })
    map.addControl(new NavigationControl({ visualizePitch: false }), 'top-right')
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left')
    const reportView = () => {
      const b = map.getBounds()
      viewRef.current({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() })
    }
    map.on('load', () => {
      addOverlays(map)
      setLoadedMap(map)
      reportView()
    })
    map.on('moveend', reportView)
    // Missing tiles while offline are expected; don't flood the console with them.
    map.on('error', (e) => {
      if (navigator.onLine) console.warn('Map error', e.error)
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
  }, [lang])

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
  const { lang } = useI18n()
  const [placingStation, setPlacingStation] = useState(false)
  const [follow, setFollow] = useState(true)
  const [view, setView] = useState<Bounds | null>(null)

  return (
    <div className="map-view">
      <MapCanvas
        lang={lang}
        placingStation={placingStation}
        onStationPlaced={() => setPlacingStation(false)}
        follow={follow}
        visible={visible}
        onViewChange={setView}
      />
      <SondeInfo
        placingStation={placingStation}
        onPlaceStation={() => setPlacingStation((p) => !p)}
        follow={follow}
        onFollow={setFollow}
      />
      <OfflineMapPanel view={view} />
    </div>
  )
}
