import type { Alarm } from '@shared/types.js';

const ALARMS_KEY = 'earlybird:alarms';

export function loadAlarms(): Alarm[] {
  try {
    const raw = localStorage.getItem(ALARMS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Alarm[];
  } catch {
    return [];
  }
}

export function saveAlarmsLocal(alarms: Alarm[]): void {
  localStorage.setItem(ALARMS_KEY, JSON.stringify(alarms));
}

export function generateId(): string {
  return crypto.randomUUID();
}
