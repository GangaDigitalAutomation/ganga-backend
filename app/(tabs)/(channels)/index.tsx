import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Animated,
  Modal,
  TextInput,
  RefreshControl,
  Linking,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Tv2, Plus, Star, Trash2, ExternalLink, Wifi, WifiOff } from 'lucide-react-native';
import { COLORS, glassCard } from '@/constants/AppColors';
import { GradientButton } from '@/components/GradientButton';
import { AnimatedPressable } from '@/components/AnimatedPressable';
import { SkeletonCard } from '@/components/SkeletonLoader';
import { apiGet, apiPost, apiPut, apiDelete } from '@/utils/api';

interface Channel {
  id: number;
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  youtube_channel_url?: string;
  is_starred: boolean;
  client_id?: string;
}

function AnimatedListItem({ index, children }: { index: number; children: React.ReactNode }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(16)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 350, delay: index * 70, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 350, delay: index * 70, useNativeDriver: true }),
    ]).start();
  }, []);
  return <Animated.View style={{ opacity, transform: [{ translateY }] }}>{children}</Animated.View>;
}

function StatusBadge({ status }: { status: string }) {
  const color = status === 'connected' ? COLORS.success : status === 'error' ? COLORS.danger : COLORS.textTertiary;
  const bg = status === 'connected' ? COLORS.successMuted : status === 'error' ? COLORS.dangerMuted : 'rgba(90,90,122,0.15)';
  const label = status === 'connected' ? 'Connected' : status === 'error' ? 'Error' : 'Disconnected';
  return (
    <View style={[styles.statusBadge, { backgroundColor: bg }]}>
      <View style={[styles.statusDot, { backgroundColor: color }]} />
      <Text style={[styles.statusText, { color }]}>{label}</Text>
    </View>
  );
}

function ChannelCard({ channel, onDelete, onToggleStar, onConnect, onVisit, onPress, index }: {
  channel: Channel;
  onDelete: (id: number) => void;
  onToggleStar: (id: number, starred: boolean) => void;
  onConnect: (id: number) => void;
  onVisit: (url: string) => void;
  onPress: (id: number) => void;
  index: number;
}) {
  const isConnected = channel.status === 'connected';
  const starColor = channel.is_starred ? COLORS.warning : COLORS.textTertiary;

  return (
    <AnimatedListItem index={index}>
      <AnimatedPressable onPress={() => {
        console.log(`[Channels] Channel card pressed: id=${channel.id} name=${channel.name}`);
        onPress(channel.id);
      }}>
        <View style={styles.channelCard}>
          <View style={styles.channelTop}>
            <View style={styles.channelIconWrap}>
              <Tv2 size={20} color={COLORS.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.channelName} numberOfLines={1}>{channel.name}</Text>
              <StatusBadge status={channel.status} />
            </View>
            <AnimatedPressable onPress={() => {
              console.log(`[Channels] Star toggle pressed: id=${channel.id} starred=${!channel.is_starred}`);
              onToggleStar(channel.id, !channel.is_starred);
            }} style={styles.iconBtn}>
              <Star size={20} color={starColor} fill={channel.is_starred ? COLORS.warning : 'transparent'} />
            </AnimatedPressable>
            <AnimatedPressable onPress={() => {
              console.log(`[Channels] Delete channel pressed: id=${channel.id}`);
              onDelete(channel.id);
            }} style={styles.iconBtn}>
              <Trash2 size={18} color={COLORS.danger} />
            </AnimatedPressable>
          </View>
          <View style={styles.channelActions}>
            {isConnected ? (
              channel.youtube_channel_url ? (
                <AnimatedPressable onPress={() => {
                  console.log(`[Channels] Visit channel pressed: url=${channel.youtube_channel_url}`);
                  onVisit(channel.youtube_channel_url!);
                }} style={styles.visitBtn}>
                  <ExternalLink size={14} color={COLORS.blue} />
                  <Text style={styles.visitText}>Visit Channel</Text>
                </AnimatedPressable>
              ) : null
            ) : (
              <AnimatedPressable onPress={() => {
                console.log(`[Channels] Connect button pressed: id=${channel.id}`);
                onConnect(channel.id);
              }} style={styles.connectBtn}>
                <Wifi size={14} color={COLORS.primary} />
                <Text style={styles.connectText}>Connect</Text>
              </AnimatedPressable>
            )}
          </View>
        </View>
      </AnimatedPressable>
    </AnimatedListItem>
  );
}

export default function ChannelsScreen() {
  const router = useRouter();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addName, setAddName] = useState('');
  const [addClientId, setAddClientId] = useState('');
  const [addClientSecret, setAddClientSecret] = useState('');
  const [adding, setAdding] = useState(false);
  const headerOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(headerOpacity, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  }, []);

  const fetchChannels = useCallback(async () => {
    try {
      const data = await apiGet<Channel[]>('/api/channels');
      setChannels(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('[Channels] fetchChannels error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchChannels(); }, [fetchChannels]);

  const handleAddChannel = async () => {
    if (!addName.trim()) return;
    console.log('[Channels] Add Channel submit pressed:', { name: addName, client_id: addClientId });
    setAdding(true);
    try {
      await apiPost('/api/channels', {
        name: addName.trim(),
        client_id: addClientId.trim(),
        client_secret: addClientSecret.trim(),
      });
      setAddName(''); setAddClientId(''); setAddClientSecret('');
      setShowAddModal(false);
      await fetchChannels();
    } catch (e) {
      console.error('[Channels] Add channel error:', e);
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await apiDelete(`/api/channels/${id}`);
      setChannels(prev => prev.filter(c => c.id !== id));
    } catch (e) {
      console.error('[Channels] Delete error:', e);
    }
  };

  const handleToggleStar = async (id: number, starred: boolean) => {
    try {
      await apiPut(`/api/channels/${id}`, { is_starred: starred });
      setChannels(prev => prev.map(c => c.id === id ? { ...c, is_starred: starred } : c));
    } catch (e) {
      console.error('[Channels] Toggle star error:', e);
    }
  };

  const handleConnect = (id: number) => {
    console.log(`[Channels] Navigating to OAuth for channel id=${id}`);
    router.push(`/oauth-webview/${id}` as any);
  };

  const handleVisit = (url: string) => {
    Linking.openURL(url).catch(e => console.error('[Channels] Open URL error:', e));
  };

  const handleCardPress = (id: number) => {
    router.push(`/channel-detail/${id}` as any);
  };

  return (
    <View style={styles.root}>
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <Animated.View style={[styles.headerRow, { opacity: headerOpacity }]}>
          <View>
            <Text style={styles.title}>Channels</Text>
            <Text style={styles.subtitle}>{channels.length} channel{channels.length !== 1 ? 's' : ''}</Text>
          </View>
          <AnimatedPressable onPress={() => {
            console.log('[Channels] Add Channel (+) button pressed');
            setShowAddModal(true);
          }} style={styles.addBtn}>
            <Plus size={22} color={COLORS.primary} />
          </AnimatedPressable>
        </Animated.View>

        {loading ? (
          <View style={{ paddingHorizontal: 16 }}>
            {[0, 1, 2].map(i => <SkeletonCard key={i} />)}
          </View>
        ) : channels.length === 0 ? (
          <View style={styles.emptyState}>
            <View style={styles.emptyIconWrap}>
              <Tv2 size={36} color={COLORS.primary} />
            </View>
            <Text style={styles.emptyTitle}>No channels yet</Text>
            <Text style={styles.emptySub}>Add your first YouTube channel to get started</Text>
            <GradientButton label="Add Channel" onPress={() => setShowAddModal(true)} style={{ marginTop: 20 }} />
          </View>
        ) : (
          <FlatList
            data={channels}
            keyExtractor={item => String(item.id)}
            renderItem={({ item, index }) => (
              <ChannelCard
                channel={item}
                onDelete={handleDelete}
                onToggleStar={handleToggleStar}
                onConnect={handleConnect}
                onVisit={handleVisit}
                onPress={handleCardPress}
                index={index}
              />
            )}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchChannels(); }} tintColor={COLORS.primary} />}
          />
        )}
      </SafeAreaView>

      {/* Add Channel Modal */}
      <Modal visible={showAddModal} transparent animationType="slide" presentationStyle="formSheet">
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Add Channel</Text>
              <Text style={styles.inputLabel}>Channel Name</Text>
              <TextInput
                style={styles.input}
                value={addName}
                onChangeText={setAddName}
                placeholder="My YouTube Channel"
                placeholderTextColor={COLORS.textTertiary}
                autoFocus
              />
              <Text style={styles.inputLabel}>Client ID</Text>
              <TextInput
                style={styles.input}
                value={addClientId}
                onChangeText={setAddClientId}
                placeholder="Google OAuth Client ID"
                placeholderTextColor={COLORS.textTertiary}
                autoCapitalize="none"
              />
              <Text style={styles.inputLabel}>Client Secret</Text>
              <TextInput
                style={styles.input}
                value={addClientSecret}
                onChangeText={setAddClientSecret}
                placeholder="Google OAuth Client Secret"
                placeholderTextColor={COLORS.textTertiary}
                secureTextEntry
                autoCapitalize="none"
              />
              <View style={styles.modalActions}>
                <AnimatedPressable onPress={() => {
                  console.log('[Channels] Add Channel modal cancelled');
                  setShowAddModal(false);
                }} style={styles.cancelBtn}>
                  <Text style={styles.cancelText}>Cancel</Text>
                </AnimatedPressable>
                <GradientButton label={adding ? 'Adding...' : 'Add Channel'} onPress={handleAddChannel} loading={adding} disabled={!addName.trim()} style={{ flex: 1 }} />
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.background },
  safeArea: { flex: 1 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8, marginBottom: 16 },
  title: { fontSize: 28, fontWeight: '700', fontFamily: 'SpaceGrotesk-Bold', color: COLORS.text, letterSpacing: -0.5 },
  subtitle: { fontSize: 14, color: COLORS.textSecondary, fontFamily: 'SpaceGrotesk-Regular', marginTop: 2 },
  addBtn: { width: 44, height: 44, borderRadius: 12, backgroundColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center' },
  listContent: { paddingHorizontal: 16, paddingBottom: 120 },
  channelCard: {
    backgroundColor: 'rgba(19,19,26,0.85)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 14,
    marginBottom: 12,
  },
  channelTop: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  channelIconWrap: { width: 40, height: 40, borderRadius: 10, backgroundColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center' },
  channelName: { fontSize: 15, fontWeight: '600', fontFamily: 'SpaceGrotesk-SemiBold', color: COLORS.text, marginBottom: 4 },
  statusBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 11, fontWeight: '600', fontFamily: 'SpaceGrotesk-SemiBold' },
  iconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  channelActions: { flexDirection: 'row', gap: 8 },
  connectBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.primaryMuted, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  connectText: { fontSize: 13, fontWeight: '600', fontFamily: 'SpaceGrotesk-SemiBold', color: COLORS.primary },
  visitBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.blueMuted, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  visitText: { fontSize: 13, fontWeight: '600', fontFamily: 'SpaceGrotesk-SemiBold', color: COLORS.blue },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  emptyIconWrap: { width: 72, height: 72, borderRadius: 20, backgroundColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  emptyTitle: { fontSize: 18, fontWeight: '600', fontFamily: 'SpaceGrotesk-SemiBold', color: COLORS.text, marginBottom: 8 },
  emptySub: { fontSize: 14, color: COLORS.textSecondary, fontFamily: 'SpaceGrotesk-Regular', textAlign: 'center', lineHeight: 20 },
  modalOverlay: { flex: 1, justifyContent: 'flex-end' },
  modalCard: { backgroundColor: COLORS.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, borderWidth: 1, borderColor: COLORS.border },
  modalTitle: { fontSize: 20, fontWeight: '700', fontFamily: 'SpaceGrotesk-Bold', color: COLORS.text, marginBottom: 20 },
  inputLabel: { fontSize: 13, fontWeight: '600', fontFamily: 'SpaceGrotesk-SemiBold', color: COLORS.textSecondary, marginBottom: 6 },
  input: { backgroundColor: COLORS.surfaceSecondary, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: COLORS.text, fontFamily: 'SpaceGrotesk-Regular', borderWidth: 1, borderColor: COLORS.border, marginBottom: 14 },
  modalActions: { flexDirection: 'row', gap: 12, marginTop: 8 },
  cancelBtn: { flex: 1, backgroundColor: COLORS.surfaceSecondary, borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  cancelText: { fontSize: 15, fontWeight: '600', fontFamily: 'SpaceGrotesk-SemiBold', color: COLORS.text },
});
