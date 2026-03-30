import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { WebView, WebViewNavigation } from 'react-native-webview';
import { COLORS } from '@/constants/AppColors';
import { apiGet, apiPost } from '@/utils/api';

const REDIRECT_URI = 'gangadigital://oauth-callback';

interface OAuthUrlResponse {
  url: string;
}

export default function OAuthWebViewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const handledRef = useRef(false);

  useEffect(() => {
    const fetchOAuthUrl = async () => {
      console.log(`[OAuthWebView] Fetching OAuth URL for channel id=${id}`);
      try {
        const data = await apiGet<OAuthUrlResponse>(
          `/api/channels/${id}/oauth-url?redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
        );
        console.log('[OAuthWebView] OAuth URL received:', data.url);
        setOauthUrl(data.url);
      } catch (e) {
        console.error('[OAuthWebView] Failed to get OAuth URL:', e);
        setError('Failed to load OAuth URL. Please try again.');
      } finally {
        setLoading(false);
      }
    };
    fetchOAuthUrl();
  }, [id]);

  const handleNavigationChange = async (navState: WebViewNavigation) => {
    const url = navState.url;
    if (!url.startsWith(REDIRECT_URI) || handledRef.current) return;
    handledRef.current = true;
    console.log('[OAuthWebView] OAuth callback detected:', url);

    try {
      const urlObj = new URL(url);
      const code = urlObj.searchParams.get('code');
      if (!code) {
        setError('No authorization code received.');
        return;
      }
      console.log('[OAuthWebView] Posting OAuth callback with code');
      await apiPost(`/api/channels/${id}/oauth-callback`, {
        code,
        redirect_uri: REDIRECT_URI,
      });
      setSuccess(true);
      console.log('[OAuthWebView] OAuth success, navigating back');
      setTimeout(() => {
        router.back();
      }, 1500);
    } catch (e) {
      console.error('[OAuthWebView] OAuth callback error:', e);
      setError('Failed to complete authorization. Please try again.');
    }
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>Loading authorization...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorTitle}>Authorization Failed</Text>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  if (success) {
    return (
      <View style={styles.centered}>
        <Text style={styles.successTitle}>Connected!</Text>
        <Text style={styles.successText}>Your channel has been successfully connected.</Text>
      </View>
    );
  }

  if (!oauthUrl) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorTitle}>No URL Available</Text>
        <Text style={styles.errorText}>Could not retrieve the authorization URL.</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <WebView
        source={{ uri: oauthUrl }}
        onNavigationStateChange={handleNavigationChange}
        style={styles.webview}
        startInLoadingState
        renderLoading={() => (
          <View style={styles.webviewLoading}>
            <ActivityIndicator size="large" color={COLORS.primary} />
          </View>
        )}
        onError={e => {
          console.error('[OAuthWebView] WebView error:', e.nativeEvent);
          setError('WebView error: ' + e.nativeEvent.description);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.background },
  webview: { flex: 1, backgroundColor: COLORS.background },
  webviewLoading: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.background },
  centered: { flex: 1, backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center', padding: 32 },
  loadingText: { fontSize: 15, color: COLORS.textSecondary, fontFamily: 'SpaceGrotesk-Regular', marginTop: 16 },
  errorTitle: { fontSize: 20, fontWeight: '700', fontFamily: 'SpaceGrotesk-Bold', color: COLORS.danger, marginBottom: 10 },
  errorText: { fontSize: 14, color: COLORS.textSecondary, fontFamily: 'SpaceGrotesk-Regular', textAlign: 'center', lineHeight: 20 },
  successTitle: { fontSize: 24, fontWeight: '700', fontFamily: 'SpaceGrotesk-Bold', color: COLORS.success, marginBottom: 10 },
  successText: { fontSize: 15, color: COLORS.textSecondary, fontFamily: 'SpaceGrotesk-Regular', textAlign: 'center', lineHeight: 22 },
});
