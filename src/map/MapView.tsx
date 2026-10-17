import { layers, namedFlavor } from '@protomaps/basemaps'
import type { Feature, FeatureCollection } from 'geojson'
import {
  LngLatBounds,
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
import { useEffect, useRef, useState, type RefObject } from 'react'
import { companions, useCompanions, type MyPosition, type RemoteTracker } from '../companion/store'
import { useI18n, type Lang } from '../i18n'
import { DEFAULT_LAUNCH } from '../sonde/demo'
import { sondes, useSondes, type SondeState } from '../sonde/store'
import { OfflineMapPanel } from './OfflineMapPanel'
import { SondeInfo, type Follow } from './SondeInfo'
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

/** `onMe`: the station follows my GPS, so the "me" marker already shows where it is. */
function stationGeoJson(state: SondeState, label: string, onMe: boolean): FeatureCollection {
  const s = state.station
  const active = state.active ? state.tracks[state.active] : undefined
  const last = active?.fixes[active.fixes.length - 1]
  const features: Feature[] = []
  if (s) {
    if (!onMe) {
      features.push({ type: 'Feature', properties: { label }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })
    }
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

/** Below this (m/s) the GPS course is mostly noise, so "me" is a dot instead of an arrow. */
const MOVING_SPEED = 1

function meGeoJson(me: MyPosition | null): FeatureCollection {
  if (!me) return { type: 'FeatureCollection', features: [] }
  const moving = me.speed !== undefined && me.speed >= MOVING_SPEED && me.course !== undefined
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { moving, course: me.course ?? 0, lost: me.lost },
        geometry: { type: 'Point', coordinates: [me.lon, me.lat] },
      },
    ],
  }
}

function trackersGeoJson(trackers: Record<string, RemoteTracker>): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: Object.values(trackers).map((t) => ({
      type: 'Feature',
      properties: { label: t.id },
      geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
    })),
  }
}

/** The "me" marker, drawn at 2x: an arrow pointing north for the map to turn by course, or a dot. */
function meImage(arrow: boolean): ImageData {
  const size = 44
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')!
  g.beginPath()
  if (arrow) {
    g.moveTo(22, 4)
    g.lineTo(38, 39)
    g.lineTo(22, 31)
    g.lineTo(6, 39)
    g.closePath()
  } else {
    g.arc(22, 22, 11, 0, 2 * Math.PI)
  }
  g.shadowColor = 'rgba(0, 0, 0, 0.7)'
  g.shadowBlur = 4
  g.fillStyle = '#ffd23f'
  g.fill()
  g.shadowColor = 'transparent'
  g.lineWidth = 3
  g.lineJoin = 'round'
  g.strokeStyle = '#0a0e14'
  g.stroke()
  return g.getImageData(0, 0, size, size)
}

function addOverlays(map: MapLibreMap) {
  const empty: FeatureCollection = { type: 'FeatureCollection', features: [] }
  map.addSource('tracks', { type: 'geojson', data: empty })
  map.addSource('sondes', { type: 'geojson', data: empty })
  map.addSource('station', { type: 'geojson', data: empty })
  map.addSource('trackers', { type: 'geojson', data: empty })
  map.addSource('me', { type: 'geojson', data: empty })
  map.addImage('me-arrow', meImage(true), { pixelRatio: 2 })
  map.addImage('me-dot', meImage(false), { pixelRatio: 2 })
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
    id: 'trackers',
    type: 'circle',
    source: 'trackers',
    paint: { 'circle-radius': 5, 'circle-color': '#b48cff', 'circle-stroke-width': 2, 'circle-stroke-color': '#0a0e14' },
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
  map.addLayer({
    id: 'tracker-labels',
    type: 'symbol',
    source: 'trackers',
    layout: { ...label, 'text-field': ['get', 'label'] },
    paint: halo,
  })
  map.addLayer({
    id: 'me',
    type: 'symbol',
    source: 'me',
    layout: {
      'icon-image': ['case', ['get', 'moving'], 'me-arrow', 'me-dot'],
      'icon-rotate': ['get', 'course'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: { 'icon-opacity': ['case', ['get', 'lost'], 0.4, 1] },
  })
}

/** Following both, don't zoom in further than this once I'm at the sonde. */
const BOTH_MAX_ZOOM = 15

/** Padding for fitting a view, with room for the info card so nothing ends up under it. */
function fitPadding(map: MapLibreMap, card: HTMLElement | null) {
  const p = { top: 50, bottom: 50, left: 50, right: 50 }
  const m = map.getContainer().getBoundingClientRect()
  const c = card?.getBoundingClientRect()
  // The card sits at the left on wide screens and across the top on narrow ones.
  if (c && c.width < m.width / 2) p.left += c.right - m.left
  else if (c) p.top += c.bottom - m.top
  // With too little room left, partly under the card beats not fitting at all.
  if (p.left + p.right > m.width - 50 || p.top + p.bottom > m.height - 50) return 50
  return p
}

type MapCanvasProps = {
  lang: Lang
  placingStation: boolean
  onStationPlaced: () => void
  follow: Follow
  /** The info card floating over the map. */
  cardRef: RefObject<HTMLDivElement | null>
  visible: boolean
  onViewChange: (bounds: Bounds) => void
}

/** The MapLibre map itself. Remounted when the language changes so labels switch too. */
function MapCanvas({ lang, placingStation, onStationPlaced, follow, cardRef, visible, onViewChange }: MapCanvasProps) {
  const { t } = useI18n()
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  // The map instance that has finished loading; a remount (language change) must wait for its own load.
  const [loadedMap, setLoadedMap] = useState<MapLibreMap | null>(null)
  const state = useSondes()
  const { me, trackers, stationFollowsGps } = useCompanions()
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
      // Placed by hand, so it should stay there.
      companions.setStationFollowsGps(false)
      sondes.setStation({ lat: e.lngLat.lat, lon: e.lngLat.lng, alt: prev?.alt ?? DEFAULT_LAUNCH.alt })
      placedRef.current()
    })
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [lang])

  const stationOnMe = stationFollowsGps && me !== null
  useEffect(() => {
    const map = loadedMap
    if (!map || map !== mapRef.current) return
    ;(map.getSource('tracks') as GeoJSONSource).setData(tracksGeoJson(state))
    ;(map.getSource('sondes') as GeoJSONSource).setData(sondesGeoJson(state))
    ;(map.getSource('station') as GeoJSONSource).setData(stationGeoJson(state, t('map.station'), stationOnMe))
  }, [state, loadedMap, t, stationOnMe])

  useEffect(() => {
    const map = loadedMap
    if (!map || map !== mapRef.current) return
    ;(map.getSource('me') as GeoJSONSource).setData(meGeoJson(me))
    ;(map.getSource('trackers') as GeoJSONSource).setData(trackersGeoJson(trackers))
  }, [me, trackers, loadedMap])

  const active = state.active ? state.tracks[state.active] : undefined
  const last = active?.fixes[active.fixes.length - 1]
  useEffect(() => {
    if (follow === 'sonde' && last && mapRef.current) mapRef.current.easeTo({ center: [last.lon, last.lat], duration: 300 })
  }, [follow, last])
  useEffect(() => {
    if (follow === 'me' && me && mapRef.current) mapRef.current.easeTo({ center: [me.lon, me.lat], duration: 300 })
  }, [follow, me])
  useEffect(() => {
    const map = mapRef.current
    if (follow !== 'both' || !map || !me) return
    if (!last) {
      map.easeTo({ center: [me.lon, me.lat], duration: 300 })
      return
    }
    const bounds = new LngLatBounds([me.lon, me.lat], [me.lon, me.lat]).extend([last.lon, last.lat])
    map.fitBounds(bounds, { padding: fitPadding(map, cardRef.current), maxZoom: BOTH_MAX_ZOOM, duration: 300 })
  }, [follow, me, last, cardRef])

  useEffect(() => {
    if (visible) mapRef.current?.resize()
  }, [visible])

  return <div ref={container} className={`map-canvas ${placingStation ? 'placing' : ''}`} />
}

export default function MapView({ visible }: { visible: boolean }) {
  const { lang } = useI18n()
  const [placingStation, setPlacingStation] = useState(false)
  const [follow, setFollow] = useState<Follow>('sonde')
  const [view, setView] = useState<Bounds | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  return (
    <div className="map-view">
      <MapCanvas
        lang={lang}
        placingStation={placingStation}
        onStationPlaced={() => setPlacingStation(false)}
        follow={follow}
        cardRef={cardRef}
        visible={visible}
        onViewChange={setView}
      />
      <SondeInfo
        placingStation={placingStation}
        onPlaceStation={() => setPlacingStation((p) => !p)}
        follow={follow}
        onFollow={setFollow}
        cardRef={cardRef}
      />
      <OfflineMapPanel view={view} />
    </div>
  )
}
