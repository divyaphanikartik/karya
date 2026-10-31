// A month calendar with marked review dates, also used to pick a date. Plain React Native, so it
// works the same on the phone and on the web with no date-picker dependency.
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useApp } from './AppProvider';
import { formatDate, fromISODate, monthGrid, todayISO } from './dates';
import { DATE_LOCALES } from './i18n';
import { Button, Card, colors, styles } from './ui';

export function MonthCalendar({ selected, onSelect, counts = {}, minDate }: {
  selected?: string | null;
  onSelect: (date: string) => void;
  counts?: Record<string, number>; // reviews due per date, shown as a number on the day
  minDate?: string; // days before this cannot be picked
}) {
  const { uiLang } = useApp();
  const locale = DATE_LOCALES[uiLang];
  const start = fromISODate(selected ?? todayISO());
  const [view, setView] = useState({ year: start.getFullYear(), month: start.getMonth() });
  const today = todayISO();
  const cells = monthGrid(view.year, view.month);
  const shift = (by: number) => {
    const d = new Date(view.year, view.month + by, 1);
    setView({ year: d.getFullYear(), month: d.getMonth() });
  };
  // Sunday-first weekday initials in the app language (1 Nov 2026 is a Sunday).
  const weekdays = Array.from({ length: 7 }, (_, i) => formatDate(`2026-11-0${i + 1}`, locale, { weekday: 'narrow' }));
  const title = formatDate(`${view.year}-${String(view.month + 1).padStart(2, '0')}-01`, locale, { month: 'long', year: 'numeric' });

  return (
    <Card style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Pressable onPress={() => shift(-1)} accessibilityLabel="previous month" style={{ padding: 10 }}>
          <Text style={styles.h2}>‹</Text>
        </Pressable>
        <Text style={styles.h2}>{title}</Text>
        <Pressable onPress={() => shift(1)} accessibilityLabel="next month" style={{ padding: 10 }}>
          <Text style={styles.h2}>›</Text>
        </Pressable>
      </View>
      <View style={{ flexDirection: 'row' }}>
        {weekdays.map((w, i) => (
          <Text key={i} style={[styles.small, { width: '14.28%', textAlign: 'center' }]}>{w}</Text>
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {cells.map((date, i) => {
          if (!date) return <View key={i} style={{ width: '14.28%', height: 46 }} />;
          const disabled = !!minDate && date < minDate;
          const isSelected = date === selected;
          const n = counts[date] ?? 0;
          return (
            <Pressable
              key={i}
              disabled={disabled}
              onPress={() => onSelect(date)}
              accessibilityLabel={formatDate(date, locale)}
              accessibilityState={{ selected: isSelected, disabled }}
              style={{ width: '14.28%', height: 46, alignItems: 'center', justifyContent: 'center' }}
            >
              <View style={{
                width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
                backgroundColor: isSelected ? colors.primary : n ? '#DCE8F7' : 'transparent',
                borderWidth: date === today ? 1.5 : 0, borderColor: colors.primary,
              }}>
                <Text style={{ fontSize: 15, color: isSelected ? '#FFFFFF' : disabled ? colors.border : colors.text, fontWeight: n ? '700' : '400' }}>
                  {Number(date.slice(8))}
                </Text>
                {n > 0 && (
                  <Text style={{ fontSize: 10, lineHeight: 11, color: isSelected ? '#FFFFFF' : date < today ? colors.warn : colors.primary }}>●{n > 1 ? n : ''}</Text>
                )}
              </View>
            </Pressable>
          );
        })}
      </View>
    </Card>
  );
}

/** "Next review: 14 Nov 2026 [Change date]", opening a calendar to pick a new date. */
export function ReviewDate({ date, onChange }: { date: string | null; onChange: (date: string) => void }) {
  const { t, uiLang } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <Text style={styles.body}>
          {t.nextReview}: <Text style={{ fontWeight: '700' }}>{date ? formatDate(date, DATE_LOCALES[uiLang]) : '-'}</Text>
        </Text>
        <Button title={open ? '✕' : t.changeDate} kind="secondary" onPress={() => setOpen(!open)} style={{ minHeight: 40 }} />
      </View>
      {open && (
        <>
          <Text style={styles.small}>{t.pickDate}</Text>
          <MonthCalendar
            selected={date}
            minDate={todayISO()}
            onSelect={(d) => {
              onChange(d);
              setOpen(false);
            }}
          />
        </>
      )}
    </View>
  );
}
