import { useCallback, useState, type ReactNode } from 'react';
import { Stack, router } from 'expo-router';
import { SQLiteProvider } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { LogBox, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppProvider, useApp } from '../lib/AppProvider';
import { migrate } from '../lib/db';
import { colors, headingFont } from '../lib/ui';

// Each role only gets its own screens: signed out -> sign-in; teacher -> students and checks;
// admin -> school dashboard. Settings is shared by both roles.
// Signing in or out swaps the screens behind the route guards; React Navigation logs a harmless
// development-only warning each time. (Not shown in production builds.)
LogBox.ignoreLogs(['was not handled by any navigator']);

// Settings is a gear in the top right corner of the two home screens.
function SettingsGear({ label }: { label: string }) {
  return (
    <Pressable onPress={() => router.push('/settings')} accessibilityRole="button" accessibilityLabel={label} hitSlop={12}
      style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
      <Text style={{ fontSize: 34, lineHeight: 38, color: '#fff' }}>⚙</Text>
    </Pressable>
  );
}

function Screens() {
  const { t, user, authReady } = useApp();
  const insets = useSafeAreaInsets(); // keeps the last rows clear of the phone's navigation bar
  if (!authReady) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  const isTeacher = user?.role === 'teacher';
  const isAdmin = user?.role === 'admin';
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingBottom: insets.bottom }}>
    <Stack screenOptions={{ headerStyle: { backgroundColor: colors.primaryDark }, headerTintColor: '#fff', headerTitleStyle: { fontFamily: headingFont }, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Protected guard={!user}>
        <Stack.Screen name="login" options={{ title: t.appTitle }} />
      </Stack.Protected>
      <Stack.Protected guard={isTeacher}>
        <Stack.Screen name="index" options={{ title: t.appTitle, headerRight: () => <SettingsGear label={t.settings} /> }} />
        <Stack.Screen name="student/new" options={{ title: t.addStudent }} />
        <Stack.Screen name="assess/[studentId]" options={{ title: t.startCheck, gestureEnabled: false }} />
        <Stack.Screen name="result/[sessionId]" options={{ title: t.result, headerBackVisible: false }} />
        <Stack.Screen name="practice/[studentId]" options={{ title: t.practiceTitle }} />
        <Stack.Screen name="calendar" options={{ title: t.calendar }} />
      </Stack.Protected>
      <Stack.Protected guard={isAdmin}>
        <Stack.Screen name="admin/index" options={{ title: 'School dashboard', headerRight: () => <SettingsGear label={t.settings} /> }} />
        <Stack.Screen name="admin/teachers" options={{ title: 'Teachers' }} />
        <Stack.Screen name="admin/student/[id]" options={{ title: 'Student' }} />
      </Stack.Protected>
      <Stack.Protected guard={!!user}>
        <Stack.Screen name="settings" options={{ title: t.settings }} />
      </Stack.Protected>
    </Stack>
    </View>
  );
}

// On web the database file can be open in only one page at a time. A reload can briefly overlap
// with the old page, so retry a few times; if Karya is really open in another tab, say so instead of
// showing a blank screen. (Plain text in all three languages: the language setting lives in this database.)
const MAX_OPEN_RETRIES = 5;

function Database({ children }: { children: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const onError = useCallback((error: Error) => {
    if (attempt >= MAX_OPEN_RETRIES) {
      console.error('Could not open the local database', error);
      setFailed(true);
      return;
    }
    setTimeout(() => setAttempt((n) => n + 1), 600 * (attempt + 1));
  }, [attempt]);

  if (failed) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: 24, justifyContent: 'center', gap: 12 }}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>Karya is open in another tab or window.</Text>
        <Text>Close the other Karya tab, then reload this page.</Text>
        <Text>कार्य दूसरे टैब में खुला है। उसे बंद करके यह पेज फिर से लोड करें।</Text>
        <Text>కార్య మరొక ట్యాబ్‌లో తెరిచి ఉంది. దాన్ని మూసివేసి ఈ పేజీని మళ్ళీ లోడ్ చేయండి.</Text>
      </View>
    );
  }
  return (
    <SQLiteProvider key={attempt} databaseName="karya.db" onInit={migrate} onError={onError}>
      {children}
    </SQLiteProvider>
  );
}

export default function RootLayout() {
  return (
    <Database>
      <AppProvider>
        <StatusBar style="light" />
        <Screens />
      </AppProvider>
    </Database>
  );
}
