import { addProtocol } from 'maplibre-gl'
import { PMTiles } from 'pmtiles'
import { cachedTileKeys, getCachedTile, putCachedTile, requestPersistentStorage } from './tileCache'
import { countTiles, tilesIn, type Bounds } from './tileMath'

/**
 * OpenStreetMap vector tiles (Protomaps planet build) mirrored on Source Cooperative.
 * It serves CORS and HTTP range requests, so the browser can pull single tiles out of
 * the planet file. No API key or extra program needed.
 */
export const REMOTE_TILES_URL = 'https://data.source.coop/protomaps/openstreetmap/v4.pmtiles'
export const SOURCE_MAX_ZOOM = 15
export const TILE_PROTOCOL = 'sondemap'
export const TILE_URL_TEMPLATE = `${TILE_PROTOCOL}://{z}/{x}/{y}`

/**
 * Satellite imagery: Sentinel-2 cloudless by EOX (s2maps.eu), 10 m per pixel, CC BY-NC-SA 4.0,
 * which allows keeping it for offline, non-commercial use. No API key.
 */
export const SATELLITE_URL = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg'
/** 10 m imagery holds no more detail past this; MapLibre stretches it above. */
export const SATELLITE_MAX_ZOOM = 14
export const SATELLITE_PROTOCOL = 'sondesat'
export const SATELLITE_URL_TEMPLATE = `${SATELLITE_PROTOCOL}://{z}/{x}/{y}`
export const SATELLITE_ATTRIBUTION =
  '<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX (Copernicus Sentinel data 2023)'

/** Above this a download would take hours and hundreds of MB; ask for a smaller area instead. */
export const MAX_DOWNLOAD_TILES = 60_000

const DOWNLOAD_CONCURRENCY = 8
const RETRIES = 2

export type Layer = 'map' | 'sat'

/** Cache keys: "z/x/y" for the map (as before), "sat/z/x/y" for the imagery. */
export const cacheKey = (layer: Layer, z: number, x: number, y: number) => (layer === 'map' ? '' : 'sat/') + `${z}/${x}/${y}`

let remote: PMTiles | null = null
const remoteSource = () => (remote ??= new PMTiles(REMOTE_TILES_URL))

async function fetchRemote(layer: Layer, z: number, x: number, y: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (layer === 'map') {
    const res = await remoteSource().getZxy(z, x, y, signal)
    return res?.data ?? new ArrayBuffer(0)
  }
  const url = SATELLITE_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
  const res = await fetch(url, { signal })
  // Outside the imagery (open ocean, the poles) there is no tile: remember that as empty.
  if (res.status === 404) return new ArrayBuffer(0)
  if (!res.ok) throw new Error(`Satellite tile ${z}/${x}/${y}: HTTP ${res.status}`)
  return res.arrayBuffer()
}

/** Cached tile, else fetch it from the internet and keep it. */
async function loadTile(layer: Layer, z: number, x: number, y: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  const key = cacheKey(layer, z, x, y)
  const cached = await getCachedTile(key)
  if (cached) return cached
  if (!navigator.onLine) throw new Error(`Tile ${key} is not saved and there is no internet`)
  const data = await fetchRemote(layer, z, x, y, signal)
  await putCachedTile(key, data)
  return data
}

let protocolRegistered = false

/** Every tile MapLibre draws goes through here, so whatever you look at while online gets saved too. */
export function registerTileProtocol() {
  if (protocolRegistered) return
  for (const [protocol, layer] of [
    [TILE_PROTOCOL, 'map'],
    [SATELLITE_PROTOCOL, 'sat'],
  ] as const) {
    addProtocol(protocol, async (params, abort) => {
      const m = /^\w+:\/\/(\d+)\/(\d+)\/(\d+)$/.exec(params.url)
      if (!m) throw new Error(`Bad tile URL ${params.url}`)
      return { data: await loadTile(layer, Number(m[1]), Number(m[2]), Number(m[3]), abort.signal) }
    })
  }
  protocolRegistered = true
}

export type DownloadProgress = { done: number; total: number; downloadedBytes: number; failed: number }

/** Tiles a download of this area takes: the map up to maxZoom plus the imagery up to its own limit. */
export function countDownloadTiles(bounds: Bounds, maxZoom: number): number {
  return countTiles(bounds, maxZoom) + countTiles(bounds, Math.min(maxZoom, SATELLITE_MAX_ZOOM))
}

/**
 * Saves the map and the satellite imagery of an area up to maxZoom, so either view works
 * offline. Already-saved tiles are skipped, so it can be resumed.
 */
export async function downloadArea(
  bounds: Bounds,
  maxZoom: number,
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<DownloadProgress> {
  void requestPersistentStorage()
  const saved = await cachedTileKeys()
  const wanted = [
    ...[...tilesIn(bounds, maxZoom)].map((t) => ({ ...t, layer: 'map' as Layer })),
    ...[...tilesIn(bounds, Math.min(maxZoom, SATELLITE_MAX_ZOOM))].map((t) => ({ ...t, layer: 'sat' as Layer })),
  ]
  const todo = wanted.filter((t) => !saved.has(cacheKey(t.layer, t.z, t.x, t.y)))
  const total = wanted.length
  const progress: DownloadProgress = { done: total - todo.length, total, downloadedBytes: 0, failed: 0 }
  onProgress({ ...progress })

  let next = 0
  const worker = async () => {
    while (next < todo.length && !signal.aborted) {
      const { layer, z, x, y } = todo[next++]
      let ok = false
      for (let attempt = 0; attempt <= RETRIES && !ok && !signal.aborted; attempt++) {
        try {
          const data = await fetchRemote(layer, z, x, y, signal)
          await putCachedTile(cacheKey(layer, z, x, y), data)
          progress.downloadedBytes += data.byteLength
          ok = true
        } catch {
          // retried below; a persistent failure is counted and skipped
        }
      }
      if (!ok && !signal.aborted) progress.failed++
      progress.done++
      onProgress({ ...progress })
    }
  }
  await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker))
  return progress
}
