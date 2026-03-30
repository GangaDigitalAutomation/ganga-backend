import "react-native-reanimated";
import React, { useEffect } from "react";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { DarkTheme, ThemeProvider } from "@react-navigation/native";
import { StatusBar } from "expo-status-bar";
import { WidgetProvider } from "@/contexts/WidgetContext";

SplashScreen.preventAutoHideAsync();

export const unstable_settings = {
  initialRouteName: "(tabs)",
};

const AppDarkTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: '#8B5CF6',
    background: '#0A0A0F',
    card: '#13131A',
    text: '#F0F0FF',
    border: 'rgba(139,92,246,0.12)',
    notification: '#EF4444',
  },
};

export default function RootLayout() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../assets/fonts/SpaceMono-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../assets/fonts/SpaceMono-Regular.ttf'),
    'SpaceGrotesk-SemiBold': require('../assets/fonts/SpaceMono-Bold.ttf'),
    'SpaceGrotesk-Bold': require('../assets/fonts/SpaceMono-Bold.ttf'),
  });

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return (
    <ThemeProvider value={AppDarkTheme}>
      <SafeAreaProvider>
        <WidgetProvider>
          <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#0A0A0F' }}>
            <StatusBar style="light" />
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0A0A0F' } }}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen
                name="channel-detail/[id]"
                options={{
                  headerShown: true,
                  headerStyle: { backgroundColor: '#13131A' },
                  headerTintColor: '#F0F0FF',
                  headerTitleStyle: { fontFamily: 'SpaceGrotesk-SemiBold', color: '#F0F0FF' },
                  headerBackTitle: 'Back',
                  presentation: 'card',
                }}
              />
              <Stack.Screen
                name="oauth-webview/[id]"
                options={{
                  headerShown: true,
                  title: 'Connect Channel',
                  headerStyle: { backgroundColor: '#13131A' },
                  headerTintColor: '#F0F0FF',
                  headerTitleStyle: { fontFamily: 'SpaceGrotesk-SemiBold', color: '#F0F0FF' },
                  presentation: 'card',
                }}
              />
            </Stack>
          </GestureHandlerRootView>
        </WidgetProvider>
      </SafeAreaProvider>
    </ThemeProvider>
  );
}
