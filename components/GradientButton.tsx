import { LinearGradient } from 'expo-linear-gradient';
import { Text, ActivityIndicator, ViewStyle, StyleProp } from 'react-native';
import { AnimatedPressable } from './AnimatedPressable';

interface Props {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  colors?: string[];
  style?: StyleProp<ViewStyle>;
}

export function GradientButton({ label, onPress, loading, disabled, colors = ['#8B5CF6', '#EC4899'], style }: Props) {
  return (
    <AnimatedPressable onPress={onPress} disabled={disabled || loading} style={style}>
      <LinearGradient
        colors={colors as [string, string]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={{
          borderRadius: 14,
          paddingVertical: 16,
          paddingHorizontal: 24,
          alignItems: 'center',
          flexDirection: 'row',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        {loading ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : (
          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700', fontFamily: 'SpaceGrotesk-Bold' }}>
            {label}
          </Text>
        )}
      </LinearGradient>
    </AnimatedPressable>
  );
}
