import { Stack } from 'expo-router';
import { SQLiteProvider } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { AppProvider, useApp } from '../lib/AppProvider';
import { migrate } from '../lib/db';
import { colors } from '../lib/ui';

function Screens() {
  const { t } = useApp();
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: colors.primary }, headerTintColor: '#fff', contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="index" options={{ title: t.appTitle }} />
      <Stack.Screen name="student/new" options={{ title: t.addStudent }} />
      <Stack.Screen name="assess/[studentId]" options={{ title: t.startCheck, gestureEnabled: false }} />
      <Stack.Screen name="result/[sessionId]" options={{ title: t.result, headerBackVisible: false }} />
      <Stack.Screen name="settings" options={{ title: t.settings }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SQLiteProvider databaseName="karya.db" onInit={migrate}>
      <AppProvider>
        <StatusBar style="light" />
        <Screens />
      </AppProvider>
    </SQLiteProvider>
  );
}
