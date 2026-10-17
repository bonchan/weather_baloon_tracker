/** Map tiles kept in IndexedDB so the map works with no internet. Keys are "z/x/y". */

const DB_NAME = 'sondetracker-map'
const STORE = 'tiles'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await openDb()).transaction(STORE, mode).objectStore(STORE)
}

export const tileKey = (z: number, x: number, y: number) => `${z}/${x}/${y}`

export async function getCachedTile(key: string): Promise<ArrayBuffer | undefined> {
  return done((await store('readonly')).get(key) as IDBRequest<ArrayBuffer | undefined>)
}

/** An empty buffer is stored for tiles the source doesn't have, so offline lookups don't treat them as missing. */
export async function putCachedTile(key: string, data: ArrayBuffer): Promise<void> {
  await done((await store('readwrite')).put(data, key))
}

export async function cachedTileKeys(): Promise<Set<string>> {
  const keys = await done((await store('readonly')).getAllKeys())
  return new Set(keys as string[])
}

export async function countCachedTiles(): Promise<number> {
  return done((await store('readonly')).count())
}

export async function clearCachedTiles(): Promise<void> {
  await done((await store('readwrite')).clear())
}

export type StorageInfo = { tiles: number; usage: number | null; quota: number | null }

export async function storageInfo(): Promise<StorageInfo> {
  const tiles = await countCachedTiles()
  try {
    const { usage, quota } = await navigator.storage.estimate()
    return { tiles, usage: usage ?? null, quota: quota ?? null }
  } catch {
    return { tiles, usage: null, quota: null }
  }
}

/** Asks the browser not to evict our data when the disk gets full. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage.persisted()) || (await navigator.storage.persist())
  } catch {
    return false
  }
}
