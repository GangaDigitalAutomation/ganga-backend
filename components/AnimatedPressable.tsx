import { Pressable, Animated, PressableProps, ViewStyle, StyleProp } from 'react-native';
import { useRef, useCallback } from 'react';

interface Props extends PressableProps {
  scaleValue?: number;
  style?: StyleProp<ViewStyle>;
}

export function AnimatedPressable({ onPress, style, children, disabled, scaleValue = 0.97, ...props }: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const animateIn = useCallback(() => {
    Animated.spring(scale, { toValue: scaleValue, useNativeDriver: true, speed: 50, bounciness: 4 }).start();
  }, [scale, scaleValue]);
  const animateOut = useCallback(() => {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 50, bounciness: 4 }).start();
  }, [scale]);
  return (
    <Animated.View style={[{ transform: [{ scale }] }, disabled && { opacity: 0.5 }]}>
      <Pressable onPressIn={animateIn} onPressOut={animateOut} onPress={onPress} disabled={disabled} style={style} {...props}>
        {children}
      </Pressable>
    </Animated.View>
  );
}
