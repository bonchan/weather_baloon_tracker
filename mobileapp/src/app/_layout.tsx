import { DarkTheme, ThemeProvider } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect } from 'react'

import AppTabs from '@/components/app-tabs'
import { startNetwork } from '@/team/network'

SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  useEffect(() => {
    void startNetwork().finally(() => SplashScreen.hideAsync())
  }, [])

  return (
    <ThemeProvider value={DarkTheme}>
      <AppTabs />
    </ThemeProvider>
  )
}
