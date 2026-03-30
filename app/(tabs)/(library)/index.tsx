import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Animated,
  TouchableOpacity,
  Modal,
  Alert,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import * as DocumentPicker from 'expo-document-picker';
import { FolderOpen, FolderVideo, Trash2, Film } from 'lucide-react-native';
import { COLORS, glassCard } from '@/constants/AppColors';
import { GradientButton } from '@/components/GradientButton';
import { AnimatedPressable } from '@/components/AnimatedPressable';
import { SkeletonCard } from '@/components/SkeletonLoader';
import { apiGet, apiPost, apiDelete } from '@/utils/api';

interface VideoFile {
  id: number;
  name: string;
  file_path: string;
  size_bytes: number;
  extension: string;
}

function formatBytes(bytes: number): string {
  const n = Number(bytes);
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

function extColor(ext: string): string {
  const e = String(ext).toLowerCase().replace('.', '');
  if (e === 'mp4') return COLORS.primary;
  if (e === 'mkv') return COLORS.accent;
  if (e === 'mov') return COLORS.blue;
  return COLORS.textSecondary;
}

function AnimatedListItem({ index, children }: { index: number; children: React.ReactNode }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(16)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 350, delay: index * 55, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 350, delay: index * 55, useNativeDriver: true }),
    ]).start();
  }, []);
  return <Animated.View style={{ opacity, transform: [{ translateY }] }}>{children}</Animated.View>;
}

function VideoCard({ video, onDelete, index }: { video: VideoFile; onDelete: (id: number) => void; index: number }) {
  const color = extColor(video.extension);
  const ext = String(video.extension).toUpperCase().replace('.', '');
  const sizeStr = formatBytes(video.size_bytes);
  const shortPath = String(video.file_path).length > 40
    ? '...' + String(video.file_path).slice(-37)
    : String(video.file_path);

  return (
    <AnimatedListItem index={index}>
      <View style={styles.videoCard}>
        <View style={[styles.extBadge, { backgroundColor: color + '22' }]}>
          <Film size={20} color={color} />
          <Text style={[styles.extText, { color }]}>{ext}</Text>
        </View>
        <View style={styles.videoInfo}>
          <Text style={styles.videoName} numberOfLines={1}>{video.name}</Text>
          <Text style={styles.videoSize}>{sizeStr}</Text>
          <Text style={styles.videoPath} numberOfLines={1}>{shortPath}</Text>
        </View>
        <AnimatedPressable onPress={() => {
          console.log(`[Library] Delete video pressed: id=${video.id} name=${video.name}`);
          onDelete(video.id);
        }} style={styles.deleteBtn}>
          <Trash2 size={18} color={COLORS.danger} />
        </AnimatedPressable>
      </View>
    </AnimatedListItem>
  );
}

export default function LibraryScreen() {
  const [videos, setVideos] = useState<VideoFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [showDeleteAll, setShowDeleteAll] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const headerOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(headerOpacity, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  }, []);

  const fetchVideos = useCallback(async () => {
    try {
      const data = await apiGet<VideoFile[]>('/api/videos');
      setVideos(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('[Library] fetchVideos error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchVideos(); }, [fetchVideos]);

  const handlePickFiles = async () => {
    console.log('[Library] Select Folder button pressed');
    setPicking(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['video/mp4', 'video/x-matroska', 'video/quicktime'],
        multiple: true,
        copyToCacheDirectory: false,
      });
      console.log('[Library] DocumentPicker result:', result);
      if (result.canceled) {
        console.log('[Library] DocumentPicker cancelled');
        return;
      }
      const assets = result.assets ?? [];
      if (assets.length === 0) return;
      const payload = assets.map(a => ({
        name: a.name,
        file_path: a.uri,
        size_bytes: a.size ?? 0,
        extension: '.' + (a.name.split('.').pop() ?? 'mp4'),
      }));
      console.log('[Library] Posting videos:', payload);
      await apiPost('/api/videos', payload);
      await fetchVideos();
    } catch (e) {
      console.error('[Library] Pick/upload error:', e);
    } finally {
      setPicking(false);
    }
  };

  const handleDeleteVideo = async (id: number) => {
    try {
      await apiDelete(`/api/videos/${id}`);
      setVideos(prev => prev.filter(v => v.id !== id));
    } catch (e) {
      console.error('[Library] Delete video error:', e);
    }
  };

  const handleDeleteAll = async () => {
    console.log('[Library] Delete All Videos confirmed');
    setDeletingAll(true);
    try {
      await apiDelete('/api/videos');
      setVideos([]);
    } catch (e) {
      console.error('[Library] Delete all error:', e);
    } finally {
      setDeletingAll(false);
      setShowDeleteAll(false);
    }
  };

  const totalSize = videos.reduce((acc, v) => acc + Number(v.size_bytes), 0);
  const totalSizeStr = formatBytes(totalSize);
  const videoCount = videos.length;

  return (
    <View style={styles.root}>
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <Animated.View style={[styles.header, { opacity: headerOpacity }]}>
          <Text style={styles.title}>Video Library</Text>
          <Text style={styles.subtitle}>{videoCount} videos · {totalSizeStr} total</Text>
        </Animated.View>

        {/* Folder Picker Card */}
        <View style={[glassCard, styles.pickerCard]}>
          <View style={styles.pickerInner}>
            <View style={styles.folderIconWrap}>
              <FolderOpen size={48} color={COLORS.primary} strokeWidth={1.5} />
            </View>
            <Text style={styles.pickerTitle}>Select Video Files</Text>
            <Text style={styles.pickerSub}>Tap to browse mp4, mkv, mov files</Text>
            <GradientButton
              label={picking ? 'Picking...' : 'Select Files'}
              onPress={handlePickFiles}
              loading={picking}
              style={{ marginTop: 12, alignSelf: 'stretch' }}
            />
          </View>
        </View>

        {loading ? (
          <View style={{ paddingHorizontal: 16 }}>
            {[0, 1, 2].map(i => <SkeletonCard key={i} />)}
          </View>
        ) : videos.length === 0 ? (
          <View style={styles.emptyState}>
            <View style={styles.emptyIconWrap}>
              <FolderVideo size={36} color={COLORS.primary} />
            </View>
            <Text style={styles.emptyTitle}>No videos yet</Text>
            <Text style={styles.emptySub}>Select files to add videos to your library</Text>
          </View>
        ) : (
          <FlatList
            data={videos}
            keyExtractor={item => String(item.id)}
            renderItem={({ item, index }) => (
              <VideoCard video={item} onDelete={handleDeleteVideo} index={index} />
            )}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchVideos(); }} tintColor={COLORS.primary} />}
            ListFooterComponent={
              <AnimatedPressable
                onPress={() => {
                  console.log('[Library] Delete All Videos button pressed');
                  setShowDeleteAll(true);
                }}
                style={styles.deleteAllBtn}
              >
                <Trash2 size={16} color={COLORS.danger} />
                <Text style={styles.deleteAllText}>Delete All Videos</Text>
              </AnimatedPressable>
            }
          />
        )}
      </SafeAreaView>

      {/* Delete All Modal */}
      <Modal visible={showDeleteAll} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Delete all videos?</Text>
            <Text style={styles.modalBody}>This will remove all {videoCount} videos from your library. This cannot be undone.</Text>
            <View style={styles.modalActions}>
              <AnimatedPressable onPress={() => setShowDeleteAll(false)} style={styles.cancelBtn}>
                <Text style={styles.cancelText}>Cancel</Text>
              </AnimatedPressable>
              <AnimatedPressable onPress={handleDeleteAll} style={styles.confirmBtn} disabled={deletingAll}>
                <Text style={styles.confirmText}>{deletingAll ? 'Deleting...' : 'Delete all'}</Text>
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
  safeArea: { flex: 1 },
  header: { paddingHorizontal: 16, paddingTop: 8, marginBottom: 16 },
  title: { fontSize: 28, fontWeight: '700', fontFamily: 'SpaceGrotesk-Bold', color: COLORS.text, letterSpacing: -0.5 },
  subtitle: { fontSize: 14, color: COLORS.textSecondary, fontFamily: 'SpaceGrotesk-Regular', marginTop: 2 },
  pickerCard: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderStyle: 'dashed',
    borderColor: COLORS.primary,
    borderWidth: 1.5,
  },
  pickerInner: { alignItems: 'center', paddingVertical: 8 },
  folderIconWrap: { marginBottom: 12 },
  pickerTitle: { fontSize: 17, fontWeight: '600', fontFamily: 'SpaceGrotesk-SemiBold', color: COLORS.text, marginBottom: 4 },
  pickerSub: { fontSize: 13, color: COLORS.textSecondary, fontFamily: 'SpaceGrotesk-Regular', textAlign: 'center' },
  listContent: { paddingHorizontal: 16, paddingBottom: 120 },
  videoCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(19,19,26,0.85)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 12,
    marginBottom: 10,
    gap: 12,
  },
  extBadge: { width: 52, height: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center', gap: 2 },
  extText: { fontSize: 9, fontWeight: '700', fontFamily: 'SpaceGrotesk-Bold' },
  videoInfo: { flex: 1, gap: 2 },
  videoName: { fontSize: 14, fontWeight: '600', fontFamily: 'SpaceGrotesk-SemiBold', color: COLORS.text },
  videoSize: { fontSize: 12, color: COLORS.primary, fontFamily: 'SpaceGrotesk-Regular' },
  videoPath: { fontSize: 11, color: COLORS.textTertiary, fontFamily: 'SpaceGrotesk-Regular' },
  deleteBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  emptyIconWrap: { width: 72, height: 72, borderRadius: 20, backgroundColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  emptyTitle: { fontSize: 18, fontWeight: '600', fontFamily: 'SpaceGrotesk-SemiBold', color: COLORS.text, marginBottom: 8 },
  emptySub: { fontSize: 14, color: COLORS.textSecondary, fontFamily: 'SpaceGrotesk-Regular', textAlign: 'center', lineHeight: 20 },
  deleteAllBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: COLORS.dangerMuted, borderRadius: 12, paddingVertical: 14, marginTop: 8, marginBottom: 8 },
  deleteAllText: { fontSize: 15, fontWeight: '600', fontFamily: 'SpaceGrotesk-SemiBold', color: COLORS.danger },
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
