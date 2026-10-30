// Shared UI pieces: large touch targets and high contrast for outdoor use on low-end phones.
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useApp } from './AppProvider';

export const colors = {
  bg: '#F7F5F0',
  card: '#FFFFFF',
  text: '#1B1B1B',
  muted: '#5C5C5C',
  primary: '#1F5FAD',
  good: '#1E7B3A',
  warn: '#B3261E',
  border: '#D9D4C7',
  wrongBg: '#FDE2E0',
  amber: '#8A5A00',
};

export function Button({ title, onPress, kind = 'primary', disabled, busy, style }: {
  title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; busy?: boolean; style?: ViewStyle;
}) {
  const bg = kind === 'primary' ? colors.primary : kind === 'danger' ? colors.warn : colors.card;
  const fg = kind === 'secondary' ? colors.primary : '#FFFFFF';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [styles.button, { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 }, kind === 'secondary' && styles.secondary, style]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Chip<T extends string | number>({ options, value, onChange, labels }: {
  options: readonly T[]; value: T; onChange: (v: T) => void; labels?: Record<string, string>;
}) {
  return (
    <View style={styles.chipRow}>
      {options.map((o) => (
        <Pressable key={String(o)} onPress={() => onChange(o)} style={[styles.chip, o === value && styles.chipOn]}>
          <Text style={[styles.chipText, o === value && styles.chipTextOn]}>{labels?.[String(o)] ?? String(o)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function SyncBanner() {
  const { online, syncing, pending, lastError, syncNow, t } = useApp();
  const waiting = pending.notes + pending.records;
  return (
    <View style={[styles.banner, { backgroundColor: online ? '#E3F1E6' : '#FFF4D6' }]}>
      <View style={{ flex: 1 }}>
        <Text style={styles.bannerTitle}>{syncing ? t.syncing : online ? t.online : t.offline}</Text>
        {pending.notes > 0 && <Text style={styles.small}>{pending.notes} {t.pendingNotes}</Text>}
        {pending.records > 0 && <Text style={styles.small}>{pending.records} {t.pendingRecords}</Text>}
        {online && lastError && <Text style={[styles.small, { color: colors.warn }]} numberOfLines={2}>{lastError}</Text>}
      </View>
      {online && waiting > 0 && !syncing && <Button title={t.syncNow} kind="secondary" onPress={syncNow} style={{ minHeight: 40 }} />}
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12 },
  h1: { fontSize: 22, fontWeight: '700', color: colors.text },
  h2: { fontSize: 18, fontWeight: '600', color: colors.text },
  label: { fontSize: 15, fontWeight: '600', color: colors.text, marginTop: 8 },
  body: { fontSize: 16, color: colors.text },
  small: { fontSize: 13, color: colors.muted },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 12, fontSize: 17, backgroundColor: colors.card },
  button: { minHeight: 52, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  secondary: { borderWidth: 1.5, borderColor: colors.primary },
  buttonText: { fontSize: 17, fontWeight: '700' },
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: colors.border, gap: 6 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 20, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.card },
  chipOn: { borderColor: colors.primary, backgroundColor: colors.primary },
  chipText: { fontSize: 16, color: colors.text },
  chipTextOn: { color: '#FFFFFF', fontWeight: '700' },
  banner: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10 },
  bannerTitle: { fontSize: 15, fontWeight: '700', color: colors.text },
  badge: { alignSelf: 'flex-start', paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12, overflow: 'hidden', fontSize: 14, fontWeight: '700', color: '#FFFFFF' },
});
