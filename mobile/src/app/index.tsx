import { useCallback, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useApp } from '../lib/AppProvider';
import { listStudents, type Student } from '../lib/db';
import { LANGUAGE_LABELS } from '../lib/i18n';
import { Button, Card, SyncBanner, colors, styles } from '../lib/ui';

export default function Home() {
  const db = useSQLiteContext();
  const { t, refreshPending } = useApp();
  const [students, setStudents] = useState<Student[]>([]);

  useFocusEffect(useCallback(() => {
    listStudents(db).then(setStudents);
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
            <Button title={`+ ${t.addStudent}`} onPress={() => router.push('/student/new')} />
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
              {item.last_level != null && (
                <Text style={[styles.badge, { backgroundColor: item.last_needs_help ? colors.warn : colors.good }]}>
                  {t.levelNames[item.last_level]} · {item.last_needs_help ? t.needsHelp : t.onTrack}
                </Text>
              )}
            </Card>
          </Pressable>
        )}
        ListFooterComponent={<Button title={t.settings} kind="secondary" onPress={() => router.push('/settings')} style={{ marginTop: 16 }} />}
      />
    </View>
  );
}
