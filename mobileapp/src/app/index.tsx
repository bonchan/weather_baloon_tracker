import { Camera, GeoJSONSource, Layer, Map, type CameraRef, type SymbolLayerSpecification } from '@maplibre/maplibre-react-native'
import type { Feature, FeatureCollection } from 'geojson'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLink } from '@/ble/link'
import { compassPoint, distanceBearing, formatDistance } from '@/geo'
import { useI18n } from '@/i18n'
import { mapStyle } from '@/map/style'
import { useTeam, type TeamState } from '@/team/store'
import { colors } from '@/theme'

/** Neuquén Aero, where the map opens before anything is known. */
const START: [number, number] = [-68.156, -38.949]

function useClock(ms: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

function people(team: TeamState, labels: { me: string; base: string }): FeatureCollection {
  const features: Feature[] = []
  if (team.base) {
    features.push({
      type: 'Feature',
      properties: { kind: 'base', label: labels.base },
      geometry: { type: 'Point', coordinates: [team.base.lon, team.base.lat] },
    })
  }
  for (const m of Object.values(team.members)) {
    features.push({
      type: 'Feature',
      properties: { kind: 'member', label: m.src },
      geometry: { type: 'Point', coordinates: [m.lon, m.lat] },
    })
  }
  if (team.me) {
    features.push({
      type: 'Feature',
      properties: { kind: 'me', label: labels.me },
      geometry: { type: 'Point', coordinates: [team.me.lon, team.me.lat] },
    })
  }
  return { type: 'FeatureCollection', features }
}

function balloon(team: TeamState): FeatureCollection {
  const track = team.sonde
  const last = track[track.length - 1]
  if (!last) return { type: 'FeatureCollection', features: [] }
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: track.map((p) => [p.lon, p.lat]) } },
      {
        type: 'Feature',
        properties: { label: `${last.serial}\n${Math.round(last.alt)} m` },
        geometry: { type: 'Point', coordinates: [last.lon, last.lat] },
      },
    ],
  }
}

const label: SymbolLayerSpecification['layout'] = {
  'text-field': ['get', 'label'],
  'text-font': ['Noto Sans Medium'],
  'text-size': 12,
  'text-anchor': 'left',
  'text-offset': [1, 0],
  'text-allow-overlap': true,
}
const halo: SymbolLayerSpecification['paint'] = { 'text-color': '#e4ebf3', 'text-halo-color': '#0a0e14', 'text-halo-width': 1.5 }

export default function MapScreen() {
  const { t, lang } = useI18n()
  const team = useTeam()
  const link = useLink()
  const now = useClock(1000)
  const camera = useRef<CameraRef>(null)
  const style = useMemo(() => mapStyle(lang), [lang])

  const last = team.sonde[team.sonde.length - 1]
  const prev = team.sonde[team.sonde.length - 2]
  const toSonde = team.me && last ? distanceBearing(team.me.lat, team.me.lon, last.lat, last.lon) : null
  const climb = last?.climb ?? (prev && last ? (last.alt - prev.alt) / Math.max(1, (last.heardAt - prev.heardAt) / 1000) : undefined)
  const teamCount = Object.keys(team.members).length

  const center = (lon: number, lat: number) => camera.current?.easeTo({ center: [lon, lat], zoom: 12, duration: 500 })

  return (
    <View style={styles.root}>
      <Map style={StyleSheet.absoluteFill} mapStyle={style} logo={false} compass attributionPosition={{ bottom: 8, right: 8 }}>
        <Camera ref={camera} initialViewState={{ center: START, zoom: 8 }} />
        <GeoJSONSource id="balloon" data={balloon(team)}>
          <Layer
            id="balloon-track"
            type="line"
            filter={['==', ['geometry-type'], 'LineString']}
            paint={{ 'line-color': '#5cc8ff', 'line-width': 3 }}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          />
          <Layer
            id="balloon-dot"
            type="circle"
            filter={['==', ['geometry-type'], 'Point']}
            paint={{ 'circle-radius': 8, 'circle-color': '#ff7ad9', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' }}
          />
          <Layer id="balloon-label" type="symbol" filter={['==', ['geometry-type'], 'Point']} layout={label} paint={halo} />
        </GeoJSONSource>
        <GeoJSONSource id="people" data={people(team, { me: t('map.me'), base: t('map.base') })}>
          <Layer
            id="people-dot"
            type="circle"
            paint={{
              'circle-radius': ['match', ['get', 'kind'], 'base', 8, 'me', 7, 6],
              'circle-color': ['match', ['get', 'kind'], 'base', '#3fd18b', 'me', '#f5d142', '#9b8cff'],
              'circle-stroke-width': 2,
              'circle-stroke-color': '#0a0e14',
            }}
          />
          <Layer id="people-label" type="symbol" layout={label} paint={halo} />
        </GeoJSONSource>
      </Map>

      <SafeAreaView edges={['top']} style={styles.top} pointerEvents="box-none">
        {link.phase !== 'connected' && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{t('map.notConnected')}</Text>
          </View>
        )}
        {!team.me && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{t('map.noGps')}</Text>
          </View>
        )}
      </SafeAreaView>

      <View style={styles.card}>
        {last ? (
          <>
            <Text style={styles.title}>
              {t('map.sonde')} <Text style={styles.serial}>{last.serial}</Text>
            </Text>
            <View style={styles.grid}>
              <Stat label={t('map.altitude')} value={`${Math.round(last.alt)} m`} />
              {climb !== undefined && <Stat label={t('map.climb')} value={`${climb.toFixed(1)} m/s`} />}
              {toSonde && <Stat label={t('map.distance')} value={formatDistance(toSonde.distance)} />}
              {toSonde && (
                <Stat label={t('map.bearing')} value={`${Math.round(toSonde.bearing)}° ${compassPoint(toSonde.bearing)}`} />
              )}
              <Stat label={t('map.lastHeard')} value={t('map.secondsAgo', { s: Math.max(0, Math.round((now - last.heardAt) / 1000)) })} />
            </View>
          </>
        ) : (
          <Text style={styles.muted}>{t('map.noSonde')}</Text>
        )}
        <View style={styles.row}>
          <Text style={styles.muted}>{t('map.team', { count: teamCount })}</Text>
          <View style={styles.buttons}>
            {team.me && (
              <Pressable style={styles.button} onPress={() => center(team.me!.lon, team.me!.lat)}>
                <Text style={styles.buttonText}>{t('map.centerMe')}</Text>
              </Pressable>
            )}
            {last && (
              <Pressable style={styles.button} onPress={() => center(last.lon, last.lat)}>
                <Text style={styles.buttonText}>{t('map.centerSonde')}</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </View>
  )
}

function Stat({ label: name, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{name}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  top: { position: 'absolute', top: 0, left: 0, right: 0, padding: 12, gap: 6 },
  banner: { backgroundColor: 'rgba(17,24,33,0.92)', borderColor: colors.warn, borderWidth: 1, borderRadius: 10, padding: 10 },
  bannerText: { color: colors.text, fontSize: 13 },
  card: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    backgroundColor: 'rgba(17,24,33,0.94)',
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 10,
  },
  title: { color: colors.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  serial: { color: '#ff9fe4', fontSize: 15, fontFamily: 'monospace' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 8 },
  stat: { width: '33%' },
  statLabel: { color: colors.muted, fontSize: 11 },
  statValue: { color: colors.text, fontSize: 15, fontFamily: 'monospace' },
  muted: { color: colors.muted, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  buttons: { flexDirection: 'row', gap: 8 },
  button: { borderColor: colors.accent, borderWidth: 1, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  buttonText: { color: colors.accent, fontWeight: '600' },
})
