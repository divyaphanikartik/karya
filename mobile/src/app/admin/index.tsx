// Admin dashboard: the whole school at a glance, read live from the server (needs internet).
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useApp } from '../../lib/AppProvider';
import { apiJson } from '../../lib/api';
import { LANGUAGE_LABELS, placedLabel } from '../../lib/i18n';
import type { Language } from '../../lib/placement';
import { Button, Card, colors, styles } from '../../lib/ui';

type StudentRow = {
  id: string; name: string; student_code: string; grade: number; language: Language;
  placed_level: number | null; needs_help: boolean | null; finished_at: string | null; last_teacher: string | null; added_by: string | null;
};
type Overview = {
  school: { name: string; code: string };
  totals: { students: number; assessed: number; needs_help: number; checks: number; teachers: number };
  levels: Record<string, { placed_level: number; students: number }[]>;
  needs_help: StudentRow[];
  recent_checks: { id: string; student_id: string; student_name: string; student_code: string; teacher_name: string; language: Language; placed_level: number; needs_help: boolean; finished_at: string }[];
};

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');

export default function AdminHome() {
  const db = useSQLiteContext();
  const { t, user } = useApp();
  const [data, setData] = useState<Overview | null>(null);
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [o, s] = await Promise.all([
        apiJson<Overview>(db, '/api/admin/overview'),
        apiJson<{ students: StudentRow[] }>(db, '/api/admin/students'),
      ]);
      setData(o);
      setStudents(s.students);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [db]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const openStudent = (id: string) => router.push({ pathname: '/admin/student/[id]', params: { id } });

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}>
      <Text style={styles.small}>{t.signedInAs}: {user?.name} · {data?.school.name ?? user?.school?.name}</Text>
      {!!error && <Card><Text style={{ color: colors.warn }}>{error}</Text><Button title="Retry" kind="secondary" onPress={load} /></Card>}

      {data && (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {([
              ['Students', data.totals.students], ['Assessed', data.totals.assessed],
              ['Need help', data.totals.needs_help], ['Checks', data.totals.checks], ['Teachers', data.totals.teachers],
            ] as const).map(([label, n]) => (
              <Card key={label} style={{ minWidth: 110, flexGrow: 1, alignItems: 'center' }}>
                <Text style={[styles.h1, label === 'Need help' && n > 0 ? { color: colors.warn } : null]}>{n}</Text>
                <Text style={styles.small}>{label}</Text>
              </Card>
            ))}
          </View>

          <Card style={{ gap: 6 }}>
            <Text style={styles.h2}>Children by reading level</Text>
            {Object.keys(data.levels).length === 0 && <Text style={styles.small}>No checks synced yet.</Text>}
            {Object.entries(data.levels).map(([lang, rows]) => (
              <Text key={lang} style={styles.body}>
                <Text style={{ fontWeight: '700' }}>{LANGUAGE_LABELS[lang as Language]}: </Text>
                {rows.map((r) => `${placedLabel(t, lang as Language, r.placed_level)} ${r.students}`).join(' · ')}
              </Text>
            ))}
          </Card>

          {data.needs_help.length > 0 && (
            <Card style={{ gap: 6 }}>
              <Text style={styles.h2}>Need extra help ({data.needs_help.length})</Text>
              {data.needs_help.map((s) => (
                <Pressable key={s.id} onPress={() => openStudent(s.id)}>
                  <Text style={styles.body}>
                    {s.name} <Text style={styles.small}>· {s.student_code} · Class {s.grade} · {LANGUAGE_LABELS[s.language]} · {placedLabel(t, s.language, s.placed_level ?? 0)}</Text>
                  </Text>
                </Pressable>
              ))}
            </Card>
          )}

          <Card style={{ gap: 6 }}>
            <Text style={styles.h2}>Recent checks</Text>
            {data.recent_checks.length === 0 && <Text style={styles.small}>None yet.</Text>}
            {data.recent_checks.map((c) => (
              <Pressable key={c.id} onPress={() => openStudent(c.student_id)}>
                <Text style={styles.body}>
                  {c.student_name} → {placedLabel(t, c.language, c.placed_level)}
                  <Text style={styles.small}> · by {c.teacher_name} · {day(c.finished_at)}</Text>
                </Text>
              </Pressable>
            ))}
          </Card>

          <Text style={styles.h2}>All students ({students.length})</Text>
          {students.map((s) => (
            <Pressable key={s.id} onPress={() => openStudent(s.id)}>
              <Card>
                <Text style={styles.h2}>{s.name}</Text>
                <Text style={styles.small}>{s.student_code} · Class {s.grade} · {LANGUAGE_LABELS[s.language]}{s.added_by ? ` · added by ${s.added_by}` : ''}</Text>
                {s.placed_level != null ? (
                  <Text style={[styles.badge, { backgroundColor: s.needs_help ? colors.warn : colors.good }]}>
                    {placedLabel(t, s.language, s.placed_level)} · {s.needs_help ? t.needsHelp : t.onTrack} · {day(s.finished_at)}
                  </Text>
                ) : <Text style={styles.small}>Not assessed yet</Text>}
              </Card>
            </Pressable>
          ))}
        </>
      )}

      <Button title="Manage teachers" onPress={() => router.push('/admin/teachers')} />
      <Button title={t.settings} kind="secondary" onPress={() => router.push('/settings')} />
    </ScrollView>
  );
}
