import React, { useRef, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, Animated, Platform } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { COLORS } from '@/constants/AppColors';
import {
  LayoutDashboard,
  FolderVideo,
  Tv2,
  CalendarClock,
} from 'lucide-react-native';

export interface GlassTabItem {
  name: string;
  route: string;
  label: string;
  icon: 'LayoutDashboard' | 'FolderVideo' | 'Tv2' | 'CalendarClock';
}

const ICON_MAP = {
  LayoutDashboard,
  FolderVideo,
  Tv2,
  CalendarClock,
};

interface Props {
  tabs: GlassTabItem[];
}

function TabIcon({ iconName, color, size }: { iconName: GlassTabItem['icon']; color: string; size: number }) {
  const IconComponent = ICON_MAP[iconName];
  return <IconComponent size={size} color={color} strokeWidth={2} />;
}

export default function GlassTabBar({ tabs }: Props) {
  const router = useRouter();
  const pathname = usePathname();

  const activeIndex = React.useMemo(() => {
    let best = 0;
    let bestScore = 0;
    tabs.forEach((tab, i) => {
      let score = 0;
      if (pathname === tab.route) score = 100;
      else if (pathname.startsWith(tab.route)) score = 80;
      else if (pathname.includes(tab.name)) score = 60;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return best;
  }, [pathname, tabs]);

  const scales = useRef(tabs.map(() => new Animated.Value(1))).current;

  const handlePress = (route: string, index: number) => {
    console.log(`[TAB] Pressed tab: ${tabs[index].label} -> ${route}`);
    Animated.sequence([
      Animated.timing(scales[index], { toValue: 0.88, duration: 80, useNativeDriver: true }),
      Animated.spring(scales[index], { toValue: 1, useNativeDriver: true, speed: 40, bounciness: 6 }),
    ]).start();
    router.push(route as any);
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <BlurView intensity={60} tint="dark" style={styles.blur}>
        <View style={styles.inner}>
          {tabs.map((tab, i) => {
            const isActive = activeIndex === i;
            const iconColor = isActive ? COLORS.primary : COLORS.textTertiary;
            const labelColor = isActive ? COLORS.primary : COLORS.textTertiary;
            return (
              <Animated.View key={tab.name} style={{ flex: 1, transform: [{ scale: scales[i] }] }}>
                <Pressable
                  style={styles.tab}
                  onPress={() => handlePress(tab.route, i)}
                  accessibilityRole="button"
                  accessibilityLabel={tab.label}
                >
                  {isActive && (
                    <View style={styles.activeGlow} />
                  )}
                  <TabIcon iconName={tab.icon} color={iconColor} size={22} />
                  <Text style={[styles.label, { color: labelColor, fontFamily: isActive ? 'SpaceGrotesk-SemiBold' : 'SpaceGrotesk-Regular' }]}>
                    {tab.label}
                  </Text>
                </Pressable>
              </Animated.View>
            );
          })}
        </View>
      </BlurView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
  },
  blur: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(139,92,246,0.2)',
    backgroundColor: Platform.OS === 'android' ? 'rgba(10,10,15,0.97)' : undefined,
  },
  inner: {
    flexDirection: 'row',
    height: 60,
    paddingHorizontal: 8,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: 8,
    position: 'relative',
  },
  activeGlow: {
    position: 'absolute',
    top: 6,
    left: '15%',
    right: '15%',
    bottom: 6,
    borderRadius: 12,
    backgroundColor: 'rgba(139,92,246,0.12)',
  },
  label: {
    fontSize: 10,
    letterSpacing: 0.2,
  },
});
