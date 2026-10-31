import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useApp } from '../lib/AppProvider';
import { formatDate, todayISO } from '../lib/dates';
import { listPracticePlans, listStudents, type PracticePlanWithStudent, type Student } from '../lib/db';
import { DATE_LOCALES, LANGUAGE_LABELS, levelLabel, placedLabel } from '../lib/i18n';
import { LADDERS, type Language } from '../lib/placement';
import { Button, Card, SyncBanner, colors, styles } from '../lib/ui';

export default function Home() {
  const db = useSQLiteContext();
  const { t, uiLang, refreshPending, user } = useApp();
  const [students, setStudents] = useState<Student[]>([]);
  const [plans, setPlans] = useState<PracticePlanWithStudent[]>([]);
  const today = todayISO();
  const locale = DATE_LOCALES[uiLang];
  // Reading checks and planned practice due today or overdue, oldest first, so nobody is forgotten.
  const due = useMemo(() => {
    const checks = students.filter((s) => s.next_review && s.next_review <= today).map((s) => ({
      key: `check-${s.id}`, name: s.name, date: s.next_review!, what: t.readingCheck,
      open: () => router.push({ pathname: '/assess/[studentId]', params: { studentId: s.id } }),
    }));
    const practice = plans.filter((p) => p.due_date <= today).map((p) => ({
      key: `plan-${p.id}`, name: p.name, date: p.due_date,
      what: `${t.practise}: ${levelLabel(t, p.language, p.level)} (${(JSON.parse(p.items_json) as string[]).join(', ')})`,
      open: () => router.push({ pathname: '/practice/[studentId]', params: { studentId: p.student_id, plan: p.id } }),
    }));
    return [...checks, ...practice].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }, [students, plans, today, t]);

  // Teaching-at-the-Right-Level groups: how many children are at each level, per reading language.
  const groups = useMemo(() => {
    const byLang = new Map<Language, number[]>();
    for (const s of students) {
      if (s.last_level == null) continue;
      const counts = byLang.get(s.language) ?? new Array<number>(LADDERS[s.language].length + 1).fill(0);
      counts[s.last_level] += 1;
      byLang.set(s.language, counts);
    }
    return [...byLang.entries()];
  }, [students]);

  useFocusEffect(useCallback(() => {
    listStudents(db).then(setStudents);
    listPracticePlans(db).then(setPlans);
    refreshPending();
  }, [db, refreshPending]));

  return (
    <View style={styles.screen}>
      <SyncBanner />
      <FlatList
        contentContainerStyle={styles.content}
        data={students}
        keyExtractor={(s) => s.id}
        ListHeaderComponent={
          <View style={{ gap: 10 }}>
            {user && (
              <Text style={styles.small}>
                {t.signedInAs}: {user.name}{user.school ? ` · ${user.school.name}` : ''}
              </Text>
            )}
            <Button title={`+ ${t.addStudent}`} onPress={() => router.push('/student/new')} />
            {due.length > 0 && (
              <Card style={{ gap: 6, borderColor: colors.warn, borderWidth: 1.5 }}>
                <Text style={styles.h2}>{t.dueNow} ({due.length})</Text>
                {due.map((d) => (
                  <Pressable key={d.key} onPress={d.open}>
                    <Text style={styles.body} numberOfLines={2}>
                      <Text style={{ fontWeight: '700' }}>{d.name}</Text>
                      {' · '}{d.what}{' · '}
                      <Text style={{ color: d.date < today ? colors.warn : colors.text }}>
                        {d.date === today ? t.today : `${formatDate(d.date, locale)} (${t.overdue})`}
                      </Text>
                      {'  ›'}
                    </Text>
                  </Pressable>
                ))}
              </Card>
            )}
            <Button title={`📅 ${t.calendar}`} kind="secondary" onPress={() => router.push('/calendar')} />
            {groups.length > 0 && (
              <Card style={{ gap: 6 }}>
                <Text style={styles.h2}>{t.groupsTitle}</Text>
                {groups.map(([lang, counts]) => (
                  <Text key={lang} style={styles.body}>
                    <Text style={{ fontWeight: '700' }}>{LANGUAGE_LABELS[lang]}: </Text>
                    {counts.flatMap((n, placed) => (n ? [`${placedLabel(t, lang, placed)} ${n}`] : [])).join(' · ')}
                  </Text>
                ))}
                <Text style={styles.small}>{t.groupsHelp}</Text>
              </Card>
            )}
            <Text style={styles.h2}>{t.students} ({students.length})</Text>
          </View>
        }
        ListEmptyComponent={<Text style={styles.small}>{t.noStudents}</Text>}
        renderItem={({ item }) => (
          <Pressable onPress={() => router.push({ pathname: '/assess/[studentId]', params: { studentId: item.id } })}>
            <Card>
              <Text style={styles.h2}>{item.name}</Text>
              <Text style={styles.small}>
                {item.student_code ? `${item.student_code} · ` : ''}{t.grade} {item.grade} · {LANGUAGE_LABELS[item.language]}
              </Text>
              {item.added_by && item.added_by !== user?.name && <Text style={styles.small}>{t.addedBy}: {item.added_by}</Text>}
              {item.last_level != null ? (
                <>
                  <Text style={[styles.badge, { backgroundColor: item.last_needs_help ? colors.warn : colors.good }]}>
                    {placedLabel(t, item.language, item.last_level)} · {item.last_needs_help ? t.needsHelp : t.onTrack}
                  </Text>
                  {item.next_review && (
                    <Text style={[styles.small, item.next_review < today && { color: colors.warn }]}>
                      {t.nextReview}: {formatDate(item.next_review, locale)}
                    </Text>
                  )}
                  <Button
                    title={t.practise}
                    kind="secondary"
                    onPress={() => router.push({ pathname: '/practice/[studentId]', params: { studentId: item.id } })}
                    style={{ minHeight: 40, alignSelf: 'flex-start', marginTop: 4 }}
                  />
                </>
              ) : (
                <Text style={styles.small}>{t.notScheduled}</Text>
              )}
            </Card>
          </Pressable>
        )}
        ListFooterComponent={<Button title={t.settings} kind="secondary" onPress={() => router.push('/settings')} style={{ marginTop: 16 }} />}
      />
    </View>
  );
}
