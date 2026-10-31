// Admin: one child's history across teachers: each check, the words missed, and the AI notes.
import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useApp } from '../../../lib/AppProvider';
import { apiJson } from '../../../lib/api';
import { LANGUAGE_LABELS, levelLabel, placedLabel } from '../../../lib/i18n';
import { tokens, type Language, type Level } from '../../../lib/placement';
import { Card, colors, styles } from '../../../lib/ui';

type Attempt = {
  id: string; level: Level; items: string[]; marks: boolean[]; accuracy: number; passed: boolean; duration_sec: number | null;
  note: { note_for_teacher: string; practice_suggestion: string } | null; note_source: string | null; transcript: string | null;
};
type Detail = {
  student: { id: string; student_code: string; name: string; grade: number; language: Language; added_by: string | null };
  sessions: { id: string; teacher_name: string | null; language: Language; grade: number; placed_level: number | null;
    needs_help: boolean | null; started_at: string; finished_at: string | null; attempts: Attempt[] }[];
};

export default function AdminStudent() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const db = useSQLiteContext();
  const { t } = useApp();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    apiJson<Detail>(db, `/api/admin/students/${id}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [db, id]);

  if (error) return <View style={styles.content}><Text style={{ color: colors.warn }}>{error}</Text></View>;
  if (!data) return <View style={styles.screen} />;
  const s = data.student;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Card>
        <Text style={styles.h1}>{s.name}</Text>
        <Text style={styles.small}>{s.student_code} · Class {s.grade} · {LANGUAGE_LABELS[s.language]}{s.added_by ? ` · added by ${s.added_by}` : ''}</Text>
      </Card>
      {data.sessions.length === 0 && <Text style={styles.small}>No checks synced yet.</Text>}
      {data.sessions.map((se) => (
        <Card key={se.id} style={{ gap: 8 }}>
          <Text style={styles.h2}>
            {se.placed_level != null ? placedLabel(t, se.language, se.placed_level) : 'Unfinished'}
            {se.needs_help != null && (
              <Text style={{ color: se.needs_help ? colors.warn : colors.good }}> · {se.needs_help ? t.needsHelp : t.onTrack}</Text>
            )}
          </Text>
          <Text style={styles.small}>{new Date(se.finished_at ?? se.started_at).toLocaleString()} · by {se.teacher_name ?? 'unknown'}</Text>
          {se.attempts.map((a) => {
            const words = tokens(a.items);
            const missed = words.filter((_, i) => a.marks[i] === false);
            return (
              <View key={a.id} style={{ gap: 2, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 6 }}>
                <Text style={styles.body}>{levelLabel(t, se.language, a.level)} · {Math.round(a.accuracy * 100)}% {a.passed ? '✓' : '✗'}</Text>
                {missed.length > 0 && <Text style={[styles.small, { color: colors.warn }]}>Missed: {missed.join(', ')}</Text>}
                {a.transcript ? <Text style={styles.small}>{t.speechHeard}: “{a.transcript}”</Text> : null}
                {a.note && (
                  <Text style={styles.small}>
                    {a.note_source === 'claude' ? t.aiNote : t.ruleNote}: {a.note.note_for_teacher} → {a.note.practice_suggestion}
                  </Text>
                )}
              </View>
            );
          })}
        </Card>
      ))}
    </ScrollView>
  );
}
