// Shared UI pieces: large touch targets and high contrast for outdoor use on low-end phones.
import type { ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useApp } from './AppProvider';

// Two looks. "classic" (the default) is restrained: warm ivory, deep slate and one brass accent, serif
// headings, hairline borders. "vivid" is the multi-colour look (violet, with a colour per language and grade).
// Change THEME to switch; text stays dark on light for outdoor use.
const THEMES = {
  classic: {
    colors: {
      bg: '#F6F3EC', card: '#FFFFFF', text: '#1B1B1F', muted: '#6B665C', primary: '#1E2A3A', primaryDark: '#141C28',
      primarySoft: '#ECE7DC', good: '#2F6B57', warn: '#9B2C2C', border: '#E6E0D3', wrongBg: '#F6E3E1',
      amber: '#8A6A2F', amberSoft: '#F3EAD3', goodSoft: '#E1EEE7', accent: '#B08D57',
    },
    languageColors: { te: '#1E2A3A', hi: '#1E2A3A', en: '#1E2A3A' } as Record<string, string>,
    gradeColors: { 1: '#B08D57', 2: '#B08D57', 3: '#B08D57' } as Record<number, string>,
    radius: 10, headingFont: Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia, "Times New Roman", serif' }),
    shadow: 0.04,
  },
  vivid: {
    colors: {
      bg: '#F4F3FB', card: '#FFFFFF', text: '#17162B', muted: '#625F7A', primary: '#5B3FD9', primaryDark: '#2B1B6B',
      primarySoft: '#EDE9FE', good: '#0B8F63', warn: '#D9363E', border: '#E3E0F1', wrongBg: '#FFE6E8',
      amber: '#B45309', amberSoft: '#FEF3C7', goodSoft: '#DCFCE7', accent: '#F59E0B',
    },
    languageColors: { te: '#EA580C', hi: '#DB2777', en: '#0284C7' } as Record<string, string>,
    gradeColors: { 1: '#F97316', 2: '#0EA5E9', 3: '#10B981' } as Record<number, string>,
    radius: 14, headingFont: undefined as string | undefined,
    shadow: 0.07,
  },
};
const THEME: keyof typeof THEMES = 'classic';
const theme = THEMES[THEME];

export const colors = theme.colors;
/** One colour per reading language and per grade (all the same in the classic look). */
export const languageColors = theme.languageColors;
export const gradeColors = theme.gradeColors;
export const headingFont = theme.headingFont;

export function Button({ title, onPress, kind = 'primary', disabled, busy, style }: {
  title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; busy?: boolean; style?: ViewStyle;
}) {
  const bg = kind === 'primary' ? colors.primary : kind === 'danger' ? colors.warn : colors.primarySoft;
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

export function Chip<T extends string | number>({ options, value, onChange, labels, colorFor }: {
  options: readonly T[]; value: T; onChange: (v: T) => void; labels?: Record<string, string>;
  colorFor?: (option: T) => string | undefined; // the colour of this option when selected (default: brand)
}) {
  return (
    <View style={styles.chipRow}>
      {options.map((o) => {
        const on = o === value;
        const tint = colorFor?.(o) ?? colors.primary;
        return (
          <Pressable key={String(o)} onPress={() => onChange(o)} style={[styles.chip, on && { borderColor: tint, backgroundColor: tint }]}>
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{labels?.[String(o)] ?? String(o)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function SyncBanner() {
  const { online, syncing, pending, syncNow, t } = useApp();
  const waiting = pending.notes + pending.records;
  return (
    <View style={[styles.banner, { backgroundColor: online ? colors.goodSoft : colors.amberSoft }]}>
      <View style={{ flex: 1 }}>
        <Text style={styles.bannerTitle}>{syncing ? t.syncing : online ? t.online : t.offline}</Text>
        {pending.notes > 0 && <Text style={styles.small}>{pending.notes} {t.pendingNotes}</Text>}
        {pending.records > 0 && <Text style={styles.small}>{pending.records} {t.pendingRecords}</Text>}
      </View>
      {waiting > 0 && !syncing && <Button title={t.syncNow} kind="secondary" onPress={syncNow} style={{ minHeight: 40 }} />}
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12 },
  h1: { fontSize: 24, fontWeight: '700', color: colors.text, fontFamily: theme.headingFont, letterSpacing: 0.2 },
  h2: { fontSize: 18, fontWeight: '600', color: colors.text, fontFamily: theme.headingFont },
  label: { fontSize: 15, fontWeight: '600', color: colors.text, marginTop: 8 },
  body: { fontSize: 16, color: colors.text },
  small: { fontSize: 13, color: colors.muted },
  input: { borderWidth: 1.5, borderColor: colors.border, borderRadius: theme.radius, padding: 12, fontSize: 17, backgroundColor: colors.card },
  button: { minHeight: 52, borderRadius: theme.radius, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  secondary: { borderWidth: 1, borderColor: colors.border },
  buttonText: { fontSize: 17, fontWeight: '700' },
  card: {
    backgroundColor: colors.card, borderRadius: theme.radius + 2, padding: 14, gap: 6, borderWidth: 1, borderColor: colors.border,
    shadowColor: '#1B1B1F', shadowOpacity: theme.shadow, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 10, paddingHorizontal: 18, borderRadius: 22, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.card },
  chipText: { fontSize: 16, color: colors.text },
  chipTextOn: { color: '#FFFFFF', fontWeight: '700' },
  banner: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10 },
  bannerTitle: { fontSize: 15, fontWeight: '700', color: colors.text },
  badge: { alignSelf: 'flex-start', paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12, overflow: 'hidden', fontSize: 14, fontWeight: '700', color: '#FFFFFF' },
});
