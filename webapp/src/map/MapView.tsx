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
import { statusColor } from '../companion/colors'
import { companions, useCompanions, type RemoteTracker } from '../companion/store'
import { useI18n, type Lang } from '../i18n'
import { launch, useLaunchSite, type LaunchSite } from '../sonde/launch'
import { useSondes, type SondeState } from '../sonde/store'
import { currentYou, useYou, youPin, type You } from '../you'
import { OfflineMapPanel } from './OfflineMapPanel'
import { SondeInfo, type Follow, type Placing } from './SondeInfo'
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

/** Below this (m/s) the GPS course is mostly noise, so I'm a dot instead of an arrow. */
const MOVING_SPEED = 1

/** Me, labelled, plus a dashed line to the active sonde. */
function youGeoJson(you: You | null, state: SondeState, label: string): FeatureCollection {
  if (!you) return { type: 'FeatureCollection', features: [] }
  const active = state.active ? state.tracks[state.active] : undefined
  const last = active?.fixes[active.fixes.length - 1]
  const moving = you.speed !== undefined && you.speed >= MOVING_SPEED && you.course !== undefined
  // Red unless a GPS has a fix right now: a placed pin, or a fix's last position.
  const fix = you.source === 'gps' && !you.stale
  const features: Feature[] = [
    {
      type: 'Feature',
      properties: { label, icon: `you-${moving ? 'arrow' : 'dot'}${fix ? '' : '-nofix'}`, course: you.course ?? 0 },
      geometry: { type: 'Point', coordinates: [you.lon, you.lat] },
    },
  ]
  if (last) {
    features.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[you.lon, you.lat], [last.lon, last.lat]] },
    })
  }
  return { type: 'FeatureCollection', features }
}

function launchGeoJson(site: LaunchSite, label: string): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { label }, geometry: { type: 'Point', coordinates: [site.lon, site.lat] } }],
  }
}

function trackersGeoJson(trackers: Record<string, RemoteTracker>, now: number): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: Object.values(trackers).map((t) => ({
      type: 'Feature',
      properties: { label: t.name, color: statusColor(t.receivedAt, now) },
      geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
    })),
  }
}

/** My marker, drawn at 2x: an arrow pointing north for the map to turn by course, or a dot. */
function youImage(arrow: boolean, color: string): ImageData {
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
  g.fillStyle = color
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
  map.addSource('launch', { type: 'geojson', data: empty })
  map.addSource('trackers', { type: 'geojson', data: empty })
  map.addSource('you', { type: 'geojson', data: empty })
  map.addImage('you-arrow', youImage(true, '#ffd23f'), { pixelRatio: 2 })
  map.addImage('you-dot', youImage(false, '#ffd23f'), { pixelRatio: 2 })
  map.addImage('you-arrow-nofix', youImage(true, '#ff4d4d'), { pixelRatio: 2 })
  map.addImage('you-dot-nofix', youImage(false, '#ff4d4d'), { pixelRatio: 2 })
  map.addLayer({
    id: 'you-link',
    type: 'line',
    source: 'you',
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
    id: 'launch',
    type: 'circle',
    source: 'launch',
    paint: { 'circle-radius': 4, 'circle-color': '#3fd18b', 'circle-stroke-width': 2, 'circle-stroke-color': '#0a0e14' },
  })
  map.addLayer({
    id: 'trackers',
    type: 'circle',
    source: 'trackers',
    paint: { 'circle-radius': 6, 'circle-color': ['get', 'color'], 'circle-stroke-width': 2, 'circle-stroke-color': '#0a0e14' },
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
  map.addLayer({ id: 'launch-label', type: 'symbol', source: 'launch', layout: { ...label, 'text-field': ['get', 'label'] }, paint: halo })
  map.addLayer({
    id: 'tracker-labels',
    type: 'symbol',
    source: 'trackers',
    layout: { ...label, 'text-field': ['get', 'label'] },
    paint: halo,
  })
  map.addLayer({
    id: 'you',
    type: 'symbol',
    source: 'you',
    filter: ['==', ['geometry-type'], 'Point'],
    layout: {
      ...label,
      'text-field': ['get', 'label'],
      'text-offset': [1.3, 0],
      'icon-image': ['get', 'icon'],
      'icon-rotate': ['get', 'course'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: halo,
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
  placing: Placing
  onPlaced: () => void
  follow: Follow
  /** The info card floating over the map. */
  cardRef: RefObject<HTMLDivElement | null>
  visible: boolean
  onViewChange: (bounds: Bounds) => void
}

/** The MapLibre map itself. Remounted when the language changes so labels switch too. */
function MapCanvas({ lang, placing, onPlaced, follow, cardRef, visible, onViewChange }: MapCanvasProps) {
  const { t } = useI18n()
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  // The map instance that has finished loading; a remount (language change) must wait for its own load.
  const [loadedMap, setLoadedMap] = useState<MapLibreMap | null>(null)
  const state = useSondes()
  const { trackers } = useCompanions()
  // Re-colors team members that went quiet even when no new position arrives.
  const [statusTick, setStatusTick] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setStatusTick(Date.now()), 5_000)
    return () => clearInterval(id)
  }, [])
  const you = useYou()
  const launchSite = useLaunchSite()
  // The map is created once; its handlers read the latest props through refs.
  const placingRef = useRef(placing)
  const placedRef = useRef(onPlaced)
  const viewRef = useRef(onViewChange)
  useEffect(() => {
    placingRef.current = placing
    placedRef.current = onPlaced
    viewRef.current = onViewChange
  })

  useEffect(() => {
    initMapLibre()
    const initial = currentYou(companions.getState().me, youPin.getState()) ?? launch.getState()
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
      const target = placingRef.current
      if (!target) return
      const { lat, lng: lon } = e.lngLat
      // A click has no ground height; keep the one already known.
      const site = launch.getState()
      if (target === 'you') youPin.set({ lat, lon, alt: youPin.getState()?.alt ?? site.alt, placedAt: Date.now() })
      else launch.set({ lat, lon, alt: site.alt })
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
    ;(map.getSource('you') as GeoJSONSource).setData(youGeoJson(you, state, t('map.youLabel')))
  }, [state, you, loadedMap, t])

  useEffect(() => {
    const map = loadedMap
    if (!map || map !== mapRef.current) return
    ;(map.getSource('launch') as GeoJSONSource).setData(launchGeoJson(launchSite, t('map.launchSite')))
  }, [launchSite, loadedMap, t])

  useEffect(() => {
    const map = loadedMap
    if (!map || map !== mapRef.current) return
    ;(map.getSource('trackers') as GeoJSONSource).setData(trackersGeoJson(trackers, statusTick))
  }, [trackers, loadedMap, statusTick])

  const active = state.active ? state.tracks[state.active] : undefined
  const last = active?.fixes[active.fixes.length - 1]
  useEffect(() => {
    if (follow === 'sonde' && last && mapRef.current) mapRef.current.easeTo({ center: [last.lon, last.lat], duration: 300 })
  }, [follow, last])
  useEffect(() => {
    if (follow === 'me' && you && mapRef.current) mapRef.current.easeTo({ center: [you.lon, you.lat], duration: 300 })
  }, [follow, you])
  useEffect(() => {
    const map = mapRef.current
    if (follow !== 'both' || !map || !you) return
    if (!last) {
      map.easeTo({ center: [you.lon, you.lat], duration: 300 })
      return
    }
    const bounds = new LngLatBounds([you.lon, you.lat], [you.lon, you.lat]).extend([last.lon, last.lat])
    map.fitBounds(bounds, { padding: fitPadding(map, cardRef.current), maxZoom: BOTH_MAX_ZOOM, duration: 300 })
  }, [follow, you, last, cardRef])

  useEffect(() => {
    if (visible) mapRef.current?.resize()
  }, [visible])

  return <div ref={container} className={`map-canvas ${placing ? 'placing' : ''}`} />
}

export default function MapView({ visible }: { visible: boolean }) {
  const { lang } = useI18n()
  const [placing, setPlacing] = useState<Placing>(null)
  const [follow, setFollow] = useState<Follow>('sonde')
  const [view, setView] = useState<Bounds | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  return (
    <div className="map-view">
      <MapCanvas
        lang={lang}
        placing={placing}
        onPlaced={() => setPlacing(null)}
        follow={follow}
        cardRef={cardRef}
        visible={visible}
        onViewChange={setView}
      />
      <SondeInfo
        placing={placing}
        onPlace={(target) => setPlacing((p) => (p === target ? null : target))}
        follow={follow}
        onFollow={setFollow}
        cardRef={cardRef}
      />
      <OfflineMapPanel view={view} />
    </div>
  )
}
