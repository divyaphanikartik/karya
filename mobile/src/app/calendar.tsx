// Review calendar: every child's next reading check and planned practice on one month view. Tap a
// day to see who is due, start their check or practice, or move a check date.
import { useCallback, useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useApp } from '../lib/AppProvider';
import { MonthCalendar, ReviewDate } from '../lib/Calendar';
import { formatDate, todayISO } from '../lib/dates';
import {
  listPracticePlans, listStudents, setNextReview, type PracticePlanWithStudent, type Student,
} from '../lib/db';
import { DATE_LOCALES, LANGUAGE_LABELS, levelLabel, placedLabel } from '../lib/i18n';
import { Button, Card, styles } from '../lib/ui';

export default function Calendar() {
  const db = useSQLiteContext();
  const { t, uiLang, refreshPending } = useApp();
  const [students, setStudents] = useState<Student[]>([]);
  const [plans, setPlans] = useState<PracticePlanWithStudent[]>([]);
  const [day, setDay] = useState(todayISO());

  const reload = useCallback(() => {
    listStudents(db).then(setStudents);
    listPracticePlans(db).then(setPlans);
  }, [db]);
  useFocusEffect(reload);

  // Each day shows how many checks and planned practice rounds fall on it.
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of students) if (s.next_review) c[s.next_review] = (c[s.next_review] ?? 0) + 1;
    for (const p of plans) c[p.due_date] = (c[p.due_date] ?? 0) + 1;
    return c;
  }, [students, plans]);
  const due = students.filter((s) => s.next_review === day);
  const dayPlans = plans.filter((p) => p.due_date === day);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <MonthCalendar selected={day} onSelect={setDay} counts={counts} />
      <Text style={styles.h2}>{formatDate(day, DATE_LOCALES[uiLang], { weekday: 'long', day: 'numeric', month: 'long' })}</Text>
      {due.length === 0 && dayPlans.length === 0 && <Text style={styles.small}>{t.noReviews}</Text>}
      {dayPlans.map((p) => (
        <Card key={p.id}>
          <Text style={styles.h2}>{p.name}</Text>
          <Text style={styles.small}>{t.practicePlan}: {levelLabel(t, p.language, p.level)}</Text>
          <Text style={styles.body} numberOfLines={2}>{t.practiseThese}: {(JSON.parse(p.items_json) as string[]).join(', ')}</Text>
          <Button
            title={t.startPractice}
            onPress={() => router.push({ pathname: '/practice/[studentId]', params: { studentId: p.student_id, plan: p.id } })}
            style={{ minHeight: 44, alignSelf: 'flex-start' }}
          />
        </Card>
      ))}
      {due.map((s) => (
        <Card key={s.id}>
          <Text style={styles.h2}>{s.name}</Text>
          <Text style={styles.small}>
            {t.grade} {s.grade} · {LANGUAGE_LABELS[s.language]}
            {s.last_level != null ? ` · ${placedLabel(t, s.language, s.last_level)}` : ''}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Button title={t.startCheck} onPress={() => router.push({ pathname: '/assess/[studentId]', params: { studentId: s.id } })} style={{ minHeight: 44 }} />
            {s.last_level != null && (
              <Button title={t.practise} kind="secondary" onPress={() => router.push({ pathname: '/practice/[studentId]', params: { studentId: s.id } })} style={{ minHeight: 44 }} />
            )}
          </View>
          <ReviewDate date={s.next_review} onChange={async (d) => { await setNextReview(db, s.id, d); reload(); await refreshPending(); }} />
        </Card>
      ))}
    </ScrollView>
  );
}
