import { addProtocol } from 'maplibre-gl'
import { PMTiles } from 'pmtiles'
import { cachedTileKeys, getCachedTile, putCachedTile, requestPersistentStorage, tileKey } from './tileCache'
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
/** Above this a download would take hours and hundreds of MB; ask for a smaller area instead. */
export const MAX_DOWNLOAD_TILES = 60_000

const DOWNLOAD_CONCURRENCY = 8
const RETRIES = 2

let remote: PMTiles | null = null
const remoteSource = () => (remote ??= new PMTiles(REMOTE_TILES_URL))

/** Cached tile, else fetch it from the internet and keep it. */
async function loadTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  const key = tileKey(z, x, y)
  const cached = await getCachedTile(key)
  if (cached) return cached
  if (!navigator.onLine) throw new Error(`Tile ${key} is not saved and there is no internet`)
  const res = await remoteSource().getZxy(z, x, y, signal)
  const data = res?.data ?? new ArrayBuffer(0)
  await putCachedTile(key, data)
  return data
}

let protocolRegistered = false

/** Every tile MapLibre draws goes through here, so whatever you look at while online gets saved too. */
export function registerTileProtocol() {
  if (protocolRegistered) return
  addProtocol(TILE_PROTOCOL, async (params, abort) => {
    const m = /^\w+:\/\/(\d+)\/(\d+)\/(\d+)$/.exec(params.url)
    if (!m) throw new Error(`Bad tile URL ${params.url}`)
    return { data: await loadTile(Number(m[1]), Number(m[2]), Number(m[3]), abort.signal) }
  })
  protocolRegistered = true
}

export type DownloadProgress = { done: number; total: number; downloadedBytes: number; failed: number }

/** Saves every tile of an area up to maxZoom. Already-saved tiles are skipped, so it can be resumed. */
export async function downloadArea(
  bounds: Bounds,
  maxZoom: number,
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<DownloadProgress> {
  void requestPersistentStorage()
  const saved = await cachedTileKeys()
  const todo = [...tilesIn(bounds, maxZoom)].filter((t) => !saved.has(tileKey(t.z, t.x, t.y)))
  const total = countTiles(bounds, maxZoom)
  const progress: DownloadProgress = { done: total - todo.length, total, downloadedBytes: 0, failed: 0 }
  onProgress({ ...progress })

  let next = 0
  const worker = async () => {
    while (next < todo.length && !signal.aborted) {
      const { z, x, y } = todo[next++]
      let ok = false
      for (let attempt = 0; attempt <= RETRIES && !ok && !signal.aborted; attempt++) {
        try {
          const res = await remoteSource().getZxy(z, x, y, signal)
          const data = res?.data ?? new ArrayBuffer(0)
          await putCachedTile(tileKey(z, x, y), data)
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
