import React from 'react';
import { Stack, Slot } from 'expo-router';
import { View } from 'react-native';
import GlassTabBar from '@/components/GlassTabBar';
import { COLORS } from '@/constants/AppColors';

const TABS = [
  { name: '(dashboard)', route: '/(tabs)/(dashboard)', label: 'Dashboard', icon: 'LayoutDashboard' as const },
  { name: '(library)', route: '/(tabs)/(library)', label: 'Library', icon: 'FolderVideo' as const },
  { name: '(channels)', route: '/(tabs)/(channels)', label: 'Channels', icon: 'Tv2' as const },
  { name: '(scheduling)', route: '/(tabs)/(scheduling)', label: 'Schedule', icon: 'CalendarClock' as const },
];

export default function TabLayout() {
  return (
    <View style={{ flex: 1, backgroundColor: COLORS.background }}>
      <Stack screenOptions={{ headerShown: false, animation: 'none', contentStyle: { backgroundColor: COLORS.background } }}>
        <Stack.Screen name="(dashboard)" />
        <Stack.Screen name="(library)" />
        <Stack.Screen name="(channels)" />
        <Stack.Screen name="(scheduling)" />
      </Stack>
      <GlassTabBar tabs={TABS} />
    </View>
  );
}
