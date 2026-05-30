import type { Alarm } from './types.js';

/**
 * 指定日時（UTC）にユーザーtzで鳴らすべきアラームを返す純粋関数。
 * WorkerはUTCで動くため、Intlでユーザーtzに変換してからHH:MM/曜日を比較する。
 */
export function matchAlarms(now: Date, alarms: Alarm[], tz: string): Alarm[] {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });

  const parts = fmt.formatToParts(now);
  const hour = parts.find(p => p.type === 'hour')?.value ?? '00';
  const minute = parts.find(p => p.type === 'minute')?.value ?? '00';
  const weekdayStr = parts.find(p => p.type === 'weekday')?.value ?? 'Sun';

  const currentTime = `${hour}:${minute}`;
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const currentDay = weekdayMap[weekdayStr] ?? -1;

  return alarms.filter(alarm => {
    if (!alarm.enabled) return false;
    if (alarm.time !== currentTime) return false;
    // days が空なら毎日
    if (alarm.days.length === 0) return true;
    return alarm.days.includes(currentDay);
  });
}
