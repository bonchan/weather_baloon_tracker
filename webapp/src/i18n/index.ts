import { useSyncExternalStore } from 'react'
import { en, type MessageKey } from './en'
import { es } from './es'

export type { MessageKey }
export type Lang = 'en' | 'es'

export const LANGUAGES: { code: Lang; label: string }[] = [
  { code: 'es', label: 'Español' },
  { code: 'en', label: 'English' },
]

const DICTIONARIES: Record<Lang, Record<MessageKey, string>> = { en, es }
const STORAGE_KEY = 'sondetracker.lang'

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'en' || saved === 'es') return saved
  } catch {
    // storage blocked; fall back to the browser language
  }
  return navigator.language.toLowerCase().startsWith('es') ? 'es' : 'en'
}

let current: Lang = initialLang()
const listeners = new Set<() => void>()
document.documentElement.lang = current

export function setLang(lang: Lang) {
  current = lang
  document.documentElement.lang = lang
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    // not fatal
  }
  for (const l of listeners) l()
}

export function getLang(): Lang {
  return current
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string

function translate(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string {
  const text = DICTIONARIES[lang][key] ?? en[key]
  return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Current language plus a translator bound to it; re-renders when the language changes. */
export function useI18n(): { lang: Lang; t: Translate } {
  const lang = useSyncExternalStore(subscribe, getLang)
  return { lang, t: (key, vars) => translate(lang, key, vars) }
}
