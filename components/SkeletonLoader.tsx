import React, { useEffect, useRef } from 'react';
import { Animated, View, ViewStyle, StyleProp } from 'react-native';
import { COLORS } from '@/constants/AppColors';

interface SkeletonLineProps {
  width: number | string;
  height?: number;
  style?: StyleProp<ViewStyle>;
}

export function SkeletonLine({ width, height = 14, style }: SkeletonLineProps) {
  const opacity = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);
  return (
    <Animated.View
      style={[
        { width, height, borderRadius: height / 2, backgroundColor: COLORS.surfaceSecondary, opacity },
        style,
      ]}
    />
  );
}

export function SkeletonCard() {
  return (
    <View style={{ backgroundColor: COLORS.surface, borderRadius: 16, borderWidth: 1, borderColor: COLORS.border, padding: 16, marginBottom: 12 }}>
      <SkeletonLine width="60%" height={16} style={{ marginBottom: 10 }} />
      <SkeletonLine width="90%" height={12} style={{ marginBottom: 8 }} />
      <SkeletonLine width="40%" height={12} />
    </View>
  );
}
