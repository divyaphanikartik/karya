// The reading check. Fully offline: items come from the on-phone content pack, the teacher
// marks misread words, and placement is computed locally. If this language's speech model is
// installed, the recording is transcribed on the phone (then deleted) and the model's flags are
// shown as suggestions; the transcript text syncs later for Claude's note.
// English children placed at word or sentence level then get ASER's meaning check.
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useApp } from '../../lib/AppProvider';
import { heardAsWritten } from '../../lib/align';
import { levelLabel } from '../../lib/i18n';
import {
  finishSession, getPack, getStudent, saveAttempt, startSession, type ContentPack, type MeaningResult, type Student,
} from '../../lib/db';
import {
  FLUENCY_LEVELS, ITEMS_PER_LEVEL, TIMED_LEVELS, accuracy, canSayMeaning, expectedLevel, isPassed, itemsReadCorrectly,
  meaningLevel, nextStep, pickItems, tokens, wordsPerMinute, type AttemptOutcome, type Level, type MeaningLevel,
  type PlacedLevel,
} from '../../lib/placement';
import { MarkSummary, ReadingItems } from '../../lib/Reading';
import {
  canQueueRecordings, discardRecording, lastOnDeviceSpeechError, onDeviceSpeechInBuild, speechSupported, transcribeRecording, useWavRecorder, type SpeechResult,
} from '../../lib/speech';
import { Button, Card, colors, styles } from '../../lib/ui';

type Read = { level: Level; items: string[]; marks: boolean[]; passed: boolean };
type MeaningCheck = { level: MeaningLevel; items: string[]; marks: boolean[]; placed: PlacedLevel };

export default function Assess() {
  const { studentId } = useLocalSearchParams<{ studentId: string }>();
  const db = useSQLiteContext();
  const { t, uiLang, refreshPending, syncNow, user, assessLang: lang } = useApp(); // lang: the language being assessed
  const recorder = useWavRecorder();

  const [student, setStudent] = useState<Student | null>(null);
  const [pack, setPack] = useState<ContentPack | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<AttemptOutcome[]>([]);
  const [level, setLevel] = useState<Level | null>(null);
  const [items, setItems] = useState<string[]>([]);
  const [marks, setMarks] = useState<boolean[]>([]);
  const [fluent, setFluent] = useState(false); // paragraph/story: teacher's ASER fluency judgement
  const [duration, setDuration] = useState<number | null>(null);
  const [timerStart, setTimerStart] = useState<number | null>(null); // reading timer for paragraph/story
  const [recorded, setRecorded] = useState(false);
  const [speech, setSpeech] = useState<SpeechResult | null>(null);
  const [pendingAudio, setPendingAudio] = useState<string | null>(null); // offline recording, sent at next sync
  const [suggested, setSuggested] = useState<boolean[]>([]); // true = speech model flagged this word
  const [speechNote, setSpeechNote] = useState('');
  const [transcribing, setTranscribing] = useState(false);
  const [micError, setMicError] = useState('');
  const [saving, setSaving] = useState(false);
  const [disagree, setDisagree] = useState<{ missed: number[]; wrong: number[] } | null>(null); // where speech and the teacher differ
  const [reviewed, setReviewed] = useState(false); // the teacher has seen the differences for this section
  const [meaning, setMeaning] = useState<MeaningCheck | null>(null);
  const reads = useRef<Read[]>([]);
  const used = useRef(new Set<string>());
  const started = useRef(false);

  // Create the session once and choose the starting level from the child's grade.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const s = await getStudent(db, studentId);
      if (!s) return router.back();
      const p = await getPack(db, lang, s.grade);
      setStudent(s);
      setPack(p);
      setSessionId(await startSession(db, s, user?.id ?? null, lang));
      const first = nextStep(s.grade, lang, []);
      if (!first.done) loadLevel(first.level, p);
    })();
  }, [db, studentId, user?.id, lang]);

  // Never leave the microphone on if the teacher navigates away mid-recording.
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;
  useEffect(() => () => {
    if (recorderRef.current.isRecording) void recorderRef.current.stop();
  }, []);

  function loadLevel(next: Level, p: ContentPack) {
    const chosen = pickItems(p.levels[next] ?? [], ITEMS_PER_LEVEL[next], used.current);
    chosen.forEach((c) => used.current.add(c));
    setLevel(next);
    setItems(chosen);
    setMarks(tokens(chosen).map(() => true));
    setFluent(false);
    setDuration(null);
    setTimerStart(null);
    setRecorded(false);
    setSpeech(null);
    setPendingAudio(null); // the saved attempt now owns any waiting recording
    setSuggested([]);
    setSpeechNote('');
    setDisagree(null);
    setReviewed(false);
  }

  const secondsSince = (start: number) => Math.round((Date.now() - start) / 100) / 10;

  function startTimer() {
    setDuration(null);
    setRecorded(false);
    setTimerStart(Date.now());
  }

  function stopTimer() {
    if (timerStart != null) setDuration(secondsSince(timerStart));
    setTimerStart(null);
  }

  function toggle(index: number) {
    setMarks((m) => m.map((v, i) => (i === index ? !v : v)));
  }

  async function startRecording() {
    setTimerStart(null); // the recording measures the reading time instead
    setMicError('');
    setSpeechNote('');
    if (!(await recorder.start())) setMicError(t.micDenied);
  }

  async function stopRecording() {
    if (!student) return;
    const { uri, duration: seconds } = await recorder.stop();
    setDuration(Math.round(seconds * 10) / 10);
    setRecorded(true);
    discardRecording(pendingAudio); // a new recording replaces one still waiting
    setPendingAudio(null);
    setTranscribing(true);
    setSpeechNote(t.speechChecking);
    try {
      // The Karya server runs IndicConformer (Telugu/Hindi) or NeMo (English) on the recording.
      const outcome = await transcribeRecording(db, lang, uri);
      if (outcome.status === 'done') {
        setSpeech(outcome.result);
        setReviewed(false); // a new transcript: show any differences again
        setDisagree(null);
        const heard = heardAsWritten(tokens(items), tokens([outcome.result.transcript]));
        setSuggested(heard.map((ok) => !ok));
        setSpeechNote(t.speechSuggested);
      } else {
        setSpeech(null);
        setSuggested([]);
        if (outcome.status === 'queued') {
          setPendingAudio(uri);
          // With the speech engine in this build, "queued" means the model is not on the phone yet.
          const why = lastOnDeviceSpeechError();
          setSpeechNote(why ? `${t.speechDeviceFailed}: ${why}` : onDeviceSpeechInBuild() ? t.speechModelMissing : t.speechQueued);
        } else {
          setSpeechNote(outcome.reason === 'no_model' ? t.speechServerMissing
            : outcome.reason === 'offline' && !canQueueRecordings ? t.speechNeedsInternet : t.speechFailed);
        }
      }
    } catch {
      // Speech must never block the check; teacher marks still work.
      setSpeech(null);
      setSuggested([]);
      setSpeechNote(t.speechFailed);
    } finally {
      setTranscribing(false);
    }
  }

  async function saveAndNext() {
    if (!student || !sessionId || !level || !pack) return;
    if (recorder.isRecording) await stopRecording();
    // Before moving on, show where the speech model and the teacher differ, in either direction. She
    // retaps whatever she wants to change; saving again keeps the marks as they then stand.
    if (!reviewed && speech) {
      const missed = marks.map((ok, i) => (ok && suggested[i] ? i : -1)).filter((i) => i >= 0);
      const wrong = marks.map((ok, i) => (!ok && suggested[i] === false ? i : -1)).filter((i) => i >= 0);
      if (missed.length || wrong.length) {
        setDisagree({ missed, wrong });
        return;
      }
    }
    setDisagree(null);
    setSaving(true);
    // A timer still running when the teacher saves counts up to now.
    const seconds = timerStart != null ? secondsSince(timerStart) : duration;
    const judgesFluency = FLUENCY_LEVELS.includes(level);
    const passed = isPassed(level, items, marks, fluent);
    await saveAttempt(db, {
      session_id: sessionId, level, items, marks, accuracy: accuracy(marks), passed,
      duration_sec: seconds, asr_transcript: speech?.transcript ?? null, asr_model: speech?.modelId ?? null,
      pending_audio_uri: pendingAudio,
      fluent: judgesFluency ? fluent : null,
    });
    reads.current.push({ level, items, marks, passed });
    const all = [...outcomes, { level, passed }];
    setOutcomes(all);
    const step = nextStep(student.grade, lang, all);
    if (step.done) {
      // ASER asks the meaning of only the words or sentences the child read correctly.
      const ml = meaningLevel(step.placed, lang);
      const read = ml ? reads.current.filter((r) => r.level === ml && r.passed).pop() : undefined;
      if (ml && read) {
        const asked = itemsReadCorrectly(read.items, read.marks);
        setMeaning({ level: ml, items: asked, marks: asked.map(() => false), placed: step.placed });
        setSaving(false);
        return;
      }
      await finish(step.placed, null);
      return;
    }
    loadLevel(step.level, pack);
    setSaving(false);
  }

  async function finish(placed: PlacedLevel, result: MeaningResult | null) {
    if (!student || !sessionId) return;
    setSaving(true);
    await finishSession(db, sessionId, placed, placed < expectedLevel(student.grade, lang), student.id, result);
    await refreshPending();
    void syncNow(); // uploads now if online; otherwise stays queued for the next connection
    router.replace({ pathname: '/result/[sessionId]', params: { sessionId } });
  }

  if (!student || !level) return <View style={styles.screen} />;

  if (meaning) {
    const hints = uiLang === 'en' ? undefined : pack?.meanings?.[uiLang];
    const explained = meaning.marks.filter(Boolean).length;
    const canSay = canSayMeaning(meaning.level, meaning.marks);
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.small}>{student.name} · {t.meaningTitle}</Text>
        <Text style={styles.body}>{t.meaningHelp[meaning.level]}</Text>
        {meaning.items.map((item, i) => {
          const ok = meaning.marks[i];
          return (
            <Pressable
              key={item}
              onPress={() => setMeaning({ ...meaning, marks: meaning.marks.map((v, j) => (j === i ? !v : v)) })}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: ok }}
              accessibilityLabel={item}
            >
              <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 2, borderColor: ok ? colors.good : colors.border }}>
                <Text style={{ fontSize: 28, color: ok ? colors.good : colors.muted }}>{ok ? '✓' : '○'}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: meaning.level === 'word' ? 30 : 24, color: colors.text }}>{item}</Text>
                  {hints?.[item] ? <Text style={styles.small}>≈ {hints[item]}</Text> : null}
                </View>
              </Card>
            </Pressable>
          );
        })}
        <Text style={styles.h2}>
          {explained} / {meaning.items.length} {t.explained} · {canSay ? t.canSay : t.cannotSay}
        </Text>
        <Text style={styles.small}>{t.meaningRule[meaning.level]}</Text>
        <Button
          title={t.saveFinish}
          busy={saving}
          onPress={() => finish(meaning.placed, { level: meaning.level, items: meaning.items, marks: meaning.marks, canSay })}
          style={{ marginTop: 8 }}
        />
        <Button title={t.skipMeaning} kind="secondary" disabled={saving} onPress={() => finish(meaning.placed, null)} />
      </ScrollView>
    );
  }

  const timed = TIMED_LEVELS.includes(level);
  const speed = timed ? wordsPerMinute(marks, duration) : null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.small}>
        {student.name} · {t.step} {outcomes.length + 1} · {levelLabel(t, lang, level)}
      </Text>
      <Text style={styles.body}>{t.readInstruction}</Text>

      <ReadingItems items={items} level={level} marks={marks} onToggle={toggle} suggested={suggested} />
      <MarkSummary level={level} marks={marks} fluent={fluent} onFluentChange={setFluent} />

      {timed && !recorder.isRecording && (
        <View style={{ gap: 4 }}>
          {timerStart == null && duration == null && <Text style={styles.small}>{t.timerHelp}</Text>}
          {timerStart != null ? (
            <Button title={`■ ${t.stopTimer}`} kind="danger" onPress={stopTimer} />
          ) : (
            <Button title={`⏱ ${t.startTimer}`} kind="secondary" onPress={startTimer} />
          )}
          {speed != null && timerStart == null && <Text style={styles.small}>{duration}s · {speed} {t.wcpm}</Text>}
        </View>
      )}

      {!speechSupported ? null : recorder.isRecording ? (
        <Button title={`■ ${t.stop}`} kind="danger" onPress={stopRecording} />
      ) : (
        <Button title={recorded ? `● ${t.reRecord}` : `● ${t.record}`} kind="secondary" onPress={startRecording} busy={transcribing} />
      )}
      {recorded && !recorder.isRecording && <Text style={styles.small}>✓ {t.recorded} ({duration}s)</Text>}
      {speech?.transcript ? <Text style={styles.small}>{t.speechHeard}: “{speech.transcript}”</Text> : null}
      {!!speechNote && <Text style={[styles.small, { color: speech ? colors.amber : colors.muted }]}>{speechNote}</Text>}
      {!!micError && <Text style={{ color: colors.warn }}>{micError}</Text>}

      {disagree && (
        <Card style={{ borderWidth: 2, borderColor: colors.amber, gap: 8 }}>
          <Text style={styles.h2}>{t.speechDiffTitle}</Text>
          {disagree.missed.length > 0 && (
            <Text style={styles.body}>{t.speechDiffMissed} <Text style={{ fontWeight: '700' }}>{disagree.missed.map((i) => tokens(items)[i]).join(' · ')}</Text></Text>
          )}
          {disagree.wrong.length > 0 && (
            <Text style={styles.body}>{t.speechDiffWrong} <Text style={{ fontWeight: '700' }}>{disagree.wrong.map((i) => tokens(items)[i]).join(' · ')}</Text></Text>
          )}
          <Text style={styles.small}>{t.speechDiffBody}</Text>
          <Button title={t.speechAdjust} onPress={() => { setReviewed(true); setDisagree(null); }} />
        </Card>
      )}

      <Button title={t.saveNext} onPress={saveAndNext} busy={saving} style={{ marginTop: 8 }} />
    </ScrollView>
  );
}
