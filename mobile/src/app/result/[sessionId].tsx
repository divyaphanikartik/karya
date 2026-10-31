// Placement result. The level is available immediately (offline); AI notes fill in after sync.
import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useApp } from '../../lib/AppProvider';
import { getSession, getStudent, sessionAttempts, type Attempt, type Session, type Student } from '../../lib/db';
import { levelLabel, placedLabel } from '../../lib/i18n';
import { TIMED_LEVELS, expectedLevel, nextGoal, speedTarget, wordsPerMinute } from '../../lib/placement';
import { Button, Card, SyncBanner, colors, styles } from '../../lib/ui';

type AiResult = {
  transcript: string | null;
  words_correct_per_minute: number | null;
  feedback: { agreement: string; error_patterns: string[]; note_for_teacher: string; practice_suggestion: string };
  feedback_source: string;
};

export default function Result() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const db = useSQLiteContext();
  const { t, syncing } = useApp();
  const [session, setSession] = useState<Session | null>(null);
  const [student, setStudent] = useState<Student | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);

  // Reload whenever a sync finishes so AI notes appear without leaving the screen.
  useEffect(() => {
    if (syncing) return;
    let cancelled = false;
    (async () => {
      const s = await getSession(db, sessionId);
      if (!s || cancelled) return;
      const [st, at] = await Promise.all([getStudent(db, s.student_id), sessionAttempts(db, sessionId)]);
      if (cancelled) return;
      setSession(s);
      setStudent(st);
      setAttempts(at);
    })();
    return () => {
      cancelled = true;
    };
  }, [db, sessionId, syncing]);

  if (!session || !student || session.placed_level == null) return <View style={styles.screen} />;

  const needsHelp = Boolean(session.needs_help);
  const lang = session.language;
  const target = speedTarget(session.grade, lang);
  const goal = nextGoal(session.placed_level, lang);
  const targetText = target ? `${target.min}${target.max ? `–${target.max}` : '+'}` : '';
  return (
    <View style={styles.screen}>
      <SyncBanner />
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <Text style={styles.h1}>{student.name}</Text>
          <Text style={styles.body}>{t.readsAt}: <Text style={{ fontWeight: '700' }}>{placedLabel(t, lang, session.placed_level)}</Text></Text>
          <Text style={styles.body}>{t.expected} {session.grade}: {placedLabel(t, lang, expectedLevel(session.grade, lang))}</Text>
          {goal && <Text style={styles.body}>{t.nextGoal}: <Text style={{ fontWeight: '700' }}>{levelLabel(t, lang, goal)}</Text></Text>}
          <Text style={[styles.badge, { backgroundColor: needsHelp ? colors.warn : colors.good, marginTop: 6 }]}>
            {needsHelp ? t.needsHelp : t.onTrack}
          </Text>
        </Card>

        <Text style={styles.h2}>{t.attempts}</Text>
        {attempts.map((a) => {
          const items: string[] = JSON.parse(a.items_json);
          const ai: AiResult | null = a.ai_result_json ? JSON.parse(a.ai_result_json) : null;
          const speed = TIMED_LEVELS.includes(a.level) ? wordsPerMinute(JSON.parse(a.marks_json), a.duration_sec) : null;
          return (
            <Card key={a.id}>
              <Text style={styles.h2}>
                {levelLabel(t, lang, a.level)} · {Math.round(a.accuracy * 100)}% {a.passed ? '✓' : '✗'}
              </Text>
              <Text style={styles.small} numberOfLines={2}>{items.join(' · ')}</Text>
              {speed != null && (
                <Text style={[styles.small, target && { color: speed >= target.min ? colors.good : colors.warn }]}>
                  {speed} {t.wcpm}{target ? ` · ${t.speedGoal}: ${targetText}` : ''}
                </Text>
              )}
              {a.ai_status === 'pending' && <Text style={styles.small}>⏳ {t.aiPending}</Text>}
              {a.asr_transcript ? <Text style={styles.small}>{t.speechHeard}: “{a.asr_transcript}”</Text> : null}
              {a.ai_status === 'failed' && <Text style={[styles.small, { color: colors.warn }]}>{t.aiFailed}</Text>}
              {ai && (
                <View style={{ gap: 4, marginTop: 4 }}>
                  {ai.feedback.agreement !== 'no_transcript' && (
                    <Text style={styles.small}>
                      {t.aiAgreement}: {t.agreementNames[ai.feedback.agreement] ?? ai.feedback.agreement.replace(/_/g, ' ')}
                    </Text>
                  )}
                  <Text style={styles.body}>{ai.feedback_source === 'claude' ? t.aiNote : t.ruleNote}: {ai.feedback.note_for_teacher}</Text>
                  <Text style={styles.body}>→ {ai.feedback.practice_suggestion}</Text>
                </View>
              )}
            </Card>
          );
        })}
        <Text style={styles.small}>{t.aiDisclaimer}</Text>
        <Button title={t.done} onPress={() => router.dismissTo('/')} />
      </ScrollView>
    </View>
  );
}
