import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Animated,
  Modal,
  RefreshControl,
  Linking,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import { Tv2, Trash2, ExternalLink, Wifi, CalendarClock, Video, X } from 'lucide-react-native';
import { COLORS, glassCard } from '@/constants/AppColors';
import { GradientButton } from '@/components/GradientButton';
import { AnimatedPressable } from '@/components/AnimatedPressable';
import { SkeletonCard } from '@/components/SkeletonLoader';
import { apiGet, apiDelete } from '@/utils/api';

interface Channel {
  id: number;
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  youtube_channel_url?: string;
  is_starred: boolean;
}

interface Schedule {
  id: number;
  channel_id: number;
  video_id: number;
  video_name?: string;
  scheduled_date: string;
  scheduled_time: string;
  status: 'pending' | 'uploading' | 'uploaded' | 'failed' | 'skipped';
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { color: string; bg: string; label: string }> = {
    pending: { color: COLORS.blue, bg: COLORS.blueMuted, label: 'Pending' },
    uploading: { color: COLORS.warning, bg: COLORS.warningMuted, label: 'Uploading' },
    uploaded: { color: COLORS.success, bg: COLORS.successMuted, label: 'Uploaded' },
    failed: { color: COLORS.danger, bg: COLORS.dangerMuted, label: 'Failed' },
    skipped: { color: COLORS.textTertiary, bg: 'rgba(90,90,122,0.15)', label: 'Skipped' },
    connected: { color: COLORS.success, bg: COLORS.successMuted, label: 'Connected' },
    disconnected: { color: COLORS.textTertiary, bg: 'rgba(90,90,122,0.15)', label: 'Disconnected' },
    error: { color: COLORS.danger, bg: COLORS.dangerMuted, label: 'Error' },
  };
  const s = map[status] ?? map['pending'];
  return (
    <View style={[styles.badge, { backgroundColor: s.bg }]}>
      <Text style={[styles.badgeText, { color: s.color }]}>{s.label}</Text>
    </View>
  );
}

function AnimatedListItem({ index, children }: { index: number; children: React.ReactNode }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(12)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 300, delay: index * 50, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 300, delay: index * 50, useNativeDriver: true }),
    ]).start();
  }, []);
  return <Animated.View style={{ opacity, transform: [{ translateY }] }}>{children}</Animated.View>;
}

export default function ChannelDetailScreen() {
  const { id, days, videosPerDay } = useLocalSearchParams<{ id: string; days?: string; videosPerDay?: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const [channel, setChannel] = useState<Channel | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);
  const [showClearModal, setShowClearModal] = useState(false);

  const fetchData = useCallback(async () => {
    if (!id) return;
    try {
      const [ch, sch] = await Promise.all([
        apiGet<Channel>(`/api/channels/${id}`),
        apiGet<Schedule[]>(`/api/schedules?channel_id=${id}`),
      ]);
      setChannel(ch);
      setSchedules(Array.isArray(sch) ? sch : []);
      navigation.setOptions({ title: ch.name ?? 'Channel Detail' });
    } catch (e) {
      console.error('[ChannelDetail] fetchData error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleDeleteSchedule = async (scheduleId: number) => {
    console.log(`[ChannelDetail] Delete schedule pressed: id=${scheduleId}`);
    try {
      await apiDelete(`/api/schedules/${scheduleId}`);
      setSchedules(prev => prev.filter(s => s.id !== scheduleId));
    } catch (e) {
      console.error('[ChannelDetail] Delete schedule error:', e);
    }
  };

  const handleClearAll = async () => {
    console.log(`[ChannelDetail] Clear All Schedules confirmed for channel id=${id}`);
    setClearingAll(true);
    try {
      await apiDelete(`/api/schedules/clear?channel_id=${id}`);
      setSchedules([]);
    } catch (e) {
      console.error('[ChannelDetail] Clear all error:', e);
    } finally {
      setClearingAll(false);
      setShowClearModal(false);
    }
  };

  const handleConnect = () => {
    console.log(`[ChannelDetail] Connect/Reconnect pressed for channel id=${id}`);
    router.push(`/oauth-webview/${id}` as any);
  };

  const handleVisit = () => {
    if (channel?.youtube_channel_url) {
      console.log(`[ChannelDetail] Visit channel pressed: ${channel.youtube_channel_url}`);
      Linking.openURL(channel.youtube_channel_url).catch(e => console.error('[ChannelDetail] Open URL error:', e));
    }
  };

  const isConnected = channel?.status === 'connected';

  return (
    <View style={styles.root}>
      <FlatList
        data={schedules}
        keyExtractor={item => String(item.id)}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} tintColor={COLORS.primary} />}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <>
            {/* Channel Info Card */}
            {loading ? (
              <SkeletonCard />
            ) : channel ? (
              <AnimatedListItem index={0}>
                <View style={[glassCard, styles.channelCard]}>
                  <View style={styles.channelTop}>
                    <View style={styles.channelIconWrap}>
                      <Tv2 size={24} color={COLORS.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.channelName}>{channel.name}</Text>
                      <StatusBadge status={channel.status} />
                    </View>
                  </View>
                  {channel.youtube_channel_url ? (
                    <AnimatedPressable onPress={handleVisit} style={styles.urlRow}>
                      <ExternalLink size={14} color={COLORS.blue} />
                      <Text style={styles.urlText} numberOfLines={1}>{channel.youtube_channel_url}</Text>
                    </AnimatedPressable>
                  ) : null}
                  <View style={styles.channelBtns}>
                    <AnimatedPressable onPress={handleConnect} style={[styles.connectBtn, { flex: 1 }]}>
                      <Wifi size={15} color={COLORS.primary} />
                      <Text style={styles.connectBtnText}>{isConnected ? 'Reconnect' : 'Connect'}</Text>
                    </AnimatedPressable>
                  </View>
                </View>
              </AnimatedListItem>
            ) : null}

            {/* Params info if passed */}
            {(days || videosPerDay) ? (
              <AnimatedListItem index={1}>
                <View style={[glassCard, styles.paramsCard]}>
                  <CalendarClock size={16} color={COLORS.blue} />
                  <Text style={styles.paramsText}>
                    Schedule config: {days ?? '?'} days · {videosPerDay ?? '?'} videos/day
                  </Text>
                </View>
              </AnimatedListItem>
            ) : null}

            {/* Schedules header */}
            <View style={styles.schedulesHeader}>
              <CalendarClock size={16} color={COLORS.textSecondary} />
              <Text style={styles.schedulesTitle}>Schedules</Text>
              <Text style={styles.schedulesCount}>{schedules.length} entries</Text>
            </View>

            {loading ? (
              <>
                <SkeletonCard />
                <SkeletonCard />
              </>
            ) : schedules.length === 0 ? (
              <View style={styles.emptyState}>
                <View style={styles.emptyIconWrap}>
                  <CalendarClock size={32} color={COLORS.primary} />
                </View>
                <Text style={styles.emptyTitle}>No schedules yet</Text>
                <Text style={styles.emptySub}>Use Smart Scheduling to auto-generate schedules for this channel</Text>
              </View>
            ) : null}
          </>
        }
        renderItem={({ item, index }) => {
          const videoLabel = item.video_name ?? `Video #${item.video_id}`;
          return (
            <AnimatedListItem index={index}>
              <View style={styles.scheduleCard}>
                <View style={styles.scheduleLeft}>
                  <Text style={styles.scheduleDate}>{item.scheduled_date}</Text>
                  <Text style={styles.scheduleTime}>{item.scheduled_time}</Text>
                </View>
                <View style={styles.scheduleMiddle}>
                  <Text style={styles.scheduleVideo} numberOfLines={1}>{videoLabel}</Text>
                  <StatusBadge status={item.status} />
                </View>
                <AnimatedPressable onPress={() => handleDeleteSchedule(item.id)} style={styles.deleteBtn}>
                  <Trash2 size={16} color={COLORS.danger} />
                </AnimatedPressable>
              </View>
            </AnimatedListItem>
          );
        }}
        ListFooterComponent={
          schedules.length > 0 ? (
            <AnimatedPressable onPress={() => {
              console.log('[ChannelDetail] Clear All Schedules button pressed');
              setShowClearModal(true);
            }} style={styles.clearAllBtn}>
              <Trash2 size={16} color={COLORS.danger} />
              <Text style={styles.clearAllText}>Clear All Schedules</Text>
            </AnimatedPressable>
          ) : null
        }
      />

      {/* Clear All Modal */}
      <Modal visible={showClearModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Clear all schedules?</Text>
            <Text style={styles.modalBody}>This will remove all {schedules.length} schedules for this channel. This cannot be undone.</Text>
            <View style={styles.modalActions}>
              <AnimatedPressable onPress={() => setShowClearModal(false)} style={styles.cancelBtn}>
                <Text style={styles.cancelText}>Cancel</Text>
              </AnimatedPressable>
              <AnimatedPressable onPress={handleClearAll} style={styles.confirmBtn} disabled={clearingAll}>
                <Text style={styles.confirmText}>{clearingAll ? 'Clearing...' : 'Clear all'}</Text>
              </AnimatedPressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.background },
  listContent: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 120 },
  channelCard: { marginBottom: 14 },
  channelTop: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  channelIconWrap: { width: 48, height: 48, borderRadius: 14, backgroundColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center' },
  channelName: { fontSize: 18, fontWeight: '700', fontFamily: 'SpaceGrotesk-Bold', color: COLORS.text, marginBottom: 6 },
  urlRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 14, backgroundColor: COLORS.blueMuted, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  urlText: { flex: 1, fontSize: 12, color: COLORS.blue, fontFamily: 'SpaceGrotesk-Regular' },
  channelBtns: { flexDirection: 'row', gap: 10 },
  connectBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: COLORS.primaryMuted, borderRadius: 10, paddingVertical: 12 },
  connectBtnText: { fontSize: 14, fontWeight: '600', fontFamily: 'SpaceGrotesk-SemiBold', color: COLORS.primary },
  paramsCard: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14, backgroundColor: COLORS.blueMuted, borderColor: 'rgba(59,130,246,0.2)' },
  paramsText: { fontSize: 13, color: COLORS.blue, fontFamily: 'SpaceGrotesk-Regular' },
  schedulesHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  schedulesTitle: { fontSize: 16, fontWeight: '600', fontFamily: 'SpaceGrotesk-SemiBold', color: COLORS.text, flex: 1 },
  schedulesCount: { fontSize: 12, color: COLORS.textTertiary, fontFamily: 'SpaceGrotesk-Regular' },
  scheduleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(19,19,26,0.85)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 12,
    marginBottom: 8,
    gap: 10,
  },
  scheduleLeft: { width: 72, gap: 2 },
  scheduleDate: { fontSize: 11, fontWeight: '600', fontFamily: 'SpaceGrotesk-SemiBold', color: COLORS.textSecondary },
  scheduleTime: { fontSize: 13, fontWeight: '700', fontFamily: 'SpaceGrotesk-Bold', color: COLORS.text },
  scheduleMiddle: { flex: 1, gap: 4 },
  scheduleVideo: { fontSize: 13, fontWeight: '500', fontFamily: 'SpaceGrotesk-Regular', color: COLORS.text },
  deleteBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  badge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  badgeText: { fontSize: 11, fontWeight: '600', fontFamily: 'SpaceGrotesk-SemiBold' },
  emptyState: { alignItems: 'center', paddingVertical: 40 },
  emptyIconWrap: { width: 64, height: 64, borderRadius: 18, backgroundColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  emptyTitle: { fontSize: 17, fontWeight: '600', fontFamily: 'SpaceGrotesk-SemiBold', color: COLORS.text, marginBottom: 8 },
  emptySub: { fontSize: 13, color: COLORS.textSecondary, fontFamily: 'SpaceGrotesk-Regular', textAlign: 'center', lineHeight: 20, maxWidth: 280 },
  clearAllBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: COLORS.dangerMuted, borderRadius: 12, paddingVertical: 14, marginTop: 8 },
  clearAllText: { fontSize: 15, fontWeight: '600', fontFamily: 'SpaceGrotesk-SemiBold', color: COLORS.danger },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: COLORS.surface, borderRadius: 20, padding: 24, width: '100%', borderWidth: 1, borderColor: COLORS.border },
  modalTitle: { fontSize: 18, fontWeight: '700', fontFamily: 'SpaceGrotesk-Bold', color: COLORS.text, marginBottom: 8 },
  modalBody: { fontSize: 14, color: COLORS.textSecondary, fontFamily: 'SpaceGrotesk-Regular', lineHeight: 20, marginBottom: 24 },
  modalActions: { flexDirection: 'row', gap: 12 },
  cancelBtn: { flex: 1, backgroundColor: COLORS.surfaceSecondary, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  cancelText: { fontSize: 15, fontWeight: '600', fontFamily: 'SpaceGrotesk-SemiBold', color: COLORS.text },
  confirmBtn: { flex: 1, backgroundColor: COLORS.dangerMuted, borderRadius: 12, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: COLORS.danger },
  confirmText: { fontSize: 15, fontWeight: '600', fontFamily: 'SpaceGrotesk-SemiBold', color: COLORS.danger },
});
