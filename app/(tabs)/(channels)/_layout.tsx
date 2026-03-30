import { Stack } from 'expo-router';
import { COLORS } from '@/constants/AppColors';

export default function ChannelsLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: COLORS.background } }}>
      <Stack.Screen name="index" />
    </Stack>
  );
}
