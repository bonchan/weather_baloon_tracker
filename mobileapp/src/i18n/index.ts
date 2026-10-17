import { useSyncExternalStore } from 'react'
import { getLocales } from 'expo-localization'

/** Source strings; Spanish must translate every key (enforced by the type below). */
const en = {
  'tab.map': 'Map',
  'tab.settings': 'Settings',

  'map.me': 'Me',
  'map.base': 'Base',
  'map.noSonde': 'No balloon yet. The base station sends it once it decodes one.',
  'map.sonde': 'Balloon',
  'map.altitude': 'Altitude',
  'map.climb': 'Climb',
  'map.distance': 'Distance',
  'map.bearing': 'Bearing',
  'map.lastHeard': 'Last heard',
  'map.secondsAgo': '{s} s ago',
  'map.centerMe': 'Me',
  'map.centerSonde': 'Balloon',
  'map.team': '{count} in the team',
  'map.noGps': 'Waiting for the phone GPS…',
  'map.notConnected': 'Not connected to a Heltec: open Settings.',

  'settings.callsign': 'Your name on the network',
  'settings.callsignHelp': '2–8 letters or digits. Others see you with this name. BASE is reserved.',
  'settings.device': 'Heltec node',
  'settings.scan': 'Search for nodes',
  'settings.scanning': 'Searching…',
  'settings.noneFound': 'No nodes found yet. Is the Heltec on and close by?',
  'settings.connect': 'Connect',
  'settings.disconnect': 'Disconnect',
  'settings.forget': 'Forget node',
  'settings.bound': 'Bound to {name}',
  'settings.interval': 'Send my position every',
  'settings.seconds': '{s} s',
  'settings.language': 'Language',
  'settings.bluetoothOff': 'Bluetooth is off. Turn it on to connect.',
  'settings.permissionDenied': 'Bluetooth or location permission was denied. Allow it in the phone settings.',

  'link.idle': 'Not connected',
  'link.scanning': 'Searching',
  'link.connecting': 'Connecting',
  'link.connected': 'Connected',
  'link.error': 'Error',
  'link.lastSent': 'Last position sent {s} s ago',
} as const

export type MessageKey = keyof typeof en

const es: Record<MessageKey, string> = {
  'tab.map': 'Mapa',
  'tab.settings': 'Ajustes',

  'map.me': 'Yo',
  'map.base': 'Base',
  'map.noSonde': 'Todavía no hay globo. La estación base lo envía cuando decodifica uno.',
  'map.sonde': 'Globo',
  'map.altitude': 'Altitud',
  'map.climb': 'Ascenso',
  'map.distance': 'Distancia',
  'map.bearing': 'Rumbo',
  'map.lastHeard': 'Última señal',
  'map.secondsAgo': 'hace {s} s',
  'map.centerMe': 'Yo',
  'map.centerSonde': 'Globo',
  'map.team': '{count} en el equipo',
  'map.noGps': 'Esperando el GPS del teléfono…',
  'map.notConnected': 'Sin conexión a un Heltec: abrí Ajustes.',

  'settings.callsign': 'Tu nombre en la red',
  'settings.callsignHelp': '2 a 8 letras o números. Los demás te ven con este nombre. BASE está reservado.',
  'settings.device': 'Nodo Heltec',
  'settings.scan': 'Buscar nodos',
  'settings.scanning': 'Buscando…',
  'settings.noneFound': 'Todavía no se encontraron nodos. ¿El Heltec está prendido y cerca?',
  'settings.connect': 'Conectar',
  'settings.disconnect': 'Desconectar',
  'settings.forget': 'Olvidar nodo',
  'settings.bound': 'Vinculado a {name}',
  'settings.interval': 'Enviar mi posición cada',
  'settings.seconds': '{s} s',
  'settings.language': 'Idioma',
  'settings.bluetoothOff': 'El Bluetooth está apagado. Prendelo para conectar.',
  'settings.permissionDenied': 'Se denegó el permiso de Bluetooth o ubicación. Habilitalo en los ajustes del teléfono.',

  'link.idle': 'Sin conexión',
  'link.scanning': 'Buscando',
  'link.connecting': 'Conectando',
  'link.connected': 'Conectado',
  'link.error': 'Error',
  'link.lastSent': 'Última posición enviada hace {s} s',
}

export type Lang = 'en' | 'es'
const DICTIONARIES: Record<Lang, Record<MessageKey, string>> = { en, es }

let current: Lang = getLocales()[0]?.languageCode === 'en' ? 'en' : 'es'
const listeners = new Set<() => void>()

export function setLang(lang: Lang) {
  current = lang
  for (const l of listeners) l()
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useI18n(): { lang: Lang; t: Translate } {
  const lang = useSyncExternalStore(subscribe, () => current)
  const t: Translate = (key, vars) => {
    const text = DICTIONARIES[lang][key]
    return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text
  }
  return { lang, t }
}
