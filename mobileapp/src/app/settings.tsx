import { useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { connect, disconnect, forget, startScan, useLink } from '@/ble/link'
import { setLang, useI18n, type Lang } from '@/i18n'
import { isValidCallsign, normalizeCallsign } from '@/protocol/pstk'
import { INTERVAL_CHOICES, updateSettings, useSettings } from '@/team/settings'
import { colors } from '@/theme'

function useClock(ms: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

export default function SettingsScreen() {
  const { t, lang } = useI18n()
  const settings = useSettings()
  const link = useLink()
  const now = useClock(1000)
  const callsignOk = isValidCallsign(settings.callsign)

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Section title={t('settings.callsign')}>
          <TextInput
            style={[styles.input, !callsignOk && settings.callsign !== '' && styles.inputBad]}
            value={settings.callsign}
            onChangeText={(text) => updateSettings({ callsign: normalizeCallsign(text) })}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="JUAN"
            placeholderTextColor={colors.muted}
            maxLength={8}
          />
          <Text style={styles.help}>{t('settings.callsignHelp')}</Text>
        </Section>

        <Section title={t('settings.device')}>
          <Text style={styles.status}>
            {t(`link.${link.phase}`)}
            {settings.deviceName ? ` · ${t('settings.bound', { name: settings.deviceName })}` : ''}
          </Text>
          {link.lastSentAt && link.phase === 'connected' && (
            <Text style={styles.help}>{t('link.lastSent', { s: Math.round((now - link.lastSentAt) / 1000) })}</Text>
          )}
          {link.problem && <Text style={styles.warn}>{t(`settings.${link.problem}`)}</Text>}
          {link.error && <Text style={styles.warn}>{link.error}</Text>}

          <View style={styles.row}>
            <Button
              label={link.phase === 'scanning' ? t('settings.scanning') : t('settings.scan')}
              onPress={() => void startScan()}
              disabled={link.phase === 'scanning'}
              primary
            />
            {link.phase === 'connected' && <Button label={t('settings.disconnect')} onPress={() => void disconnect()} />}
            {settings.deviceId && <Button label={t('settings.forget')} onPress={() => void forget()} />}
          </View>

          {link.phase === 'scanning' && link.found.length === 0 && <Text style={styles.help}>{t('settings.noneFound')}</Text>}
          {link.found.map((node) => (
            <View key={node.id} style={styles.node}>
              <View>
                <Text style={styles.nodeName}>{node.name}</Text>
                <Text style={styles.help}>{node.rssi !== null ? `${node.rssi} dBm` : node.id}</Text>
              </View>
              <Button label={t('settings.connect')} onPress={() => void connect(node.id, node.name)} primary />
            </View>
          ))}
        </Section>

        <Section title={t('settings.interval')}>
          <View style={styles.row}>
            {INTERVAL_CHOICES.map((s) => (
              <Chip
                key={s}
                label={t('settings.seconds', { s })}
                active={settings.intervalS === s}
                onPress={() => updateSettings({ intervalS: s })}
              />
            ))}
          </View>
        </Section>

        <Section title={t('settings.language')}>
          <View style={styles.row}>
            {(['es', 'en'] as Lang[]).map((l) => (
              <Chip key={l} label={l === 'es' ? 'Español' : 'English'} active={lang === l} onPress={() => setLang(l)} />
            ))}
          </View>
        </Section>
      </ScrollView>
    </SafeAreaView>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  )
}

function Button({ label, onPress, primary, disabled }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.button, primary && styles.buttonPrimary, disabled && styles.disabled]}>
      <Text style={[styles.buttonText, primary && styles.buttonTextPrimary]}>{label}</Text>
    </Pressable>
  )
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 14, paddingBottom: 120 },
  section: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: 12, padding: 14, gap: 10 },
  sectionTitle: { color: colors.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  input: {
    color: colors.text,
    fontSize: 20,
    fontFamily: 'monospace',
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  inputBad: { borderColor: colors.warn },
  help: { color: colors.muted, fontSize: 12 },
  status: { color: colors.text, fontSize: 15 },
  warn: { color: colors.warn, fontSize: 13 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  node: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopColor: colors.border,
    borderTopWidth: 1,
    paddingTop: 10,
  },
  nodeName: { color: colors.text, fontSize: 15 },
  button: { borderColor: colors.border, borderWidth: 1, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14 },
  buttonPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  buttonText: { color: colors.text, fontWeight: '600' },
  buttonTextPrimary: { color: colors.accentInk },
  disabled: { opacity: 0.5 },
  chip: { borderColor: colors.border, borderWidth: 1, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 14 },
  chipActive: { borderColor: colors.accent, backgroundColor: 'rgba(92,200,255,0.14)' },
  chipText: { color: colors.text },
  chipTextActive: { color: colors.accent },
})
