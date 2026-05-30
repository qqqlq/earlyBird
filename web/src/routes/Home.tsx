import { useState, useEffect } from 'react';
import type { Alarm } from '@shared/types.js';
import { loadAlarms, saveAlarmsLocal, generateId } from '../lib/storage.js';
import { registerPush, saveAlarms, sendTestPush } from '../lib/api.js';
import './Home.css';

const DAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

function AlarmCard({
  alarm,
  onToggle,
  onDelete,
}: {
  alarm: Alarm;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const dayText =
    alarm.days.length === 0
      ? '毎日'
      : alarm.days.map(d => DAY_LABELS[d]).join('・');

  return (
    <div className={`alarm-card ${alarm.enabled ? 'active' : 'inactive'}`}>
      <div className="alarm-card-main">
        <span className="alarm-time">{alarm.time}</span>
        <span className="alarm-meta">
          {dayText} · スクワット {alarm.task.reps}回
        </span>
      </div>
      <div className="alarm-card-actions">
        <button
          className={`toggle-btn ${alarm.enabled ? 'on' : 'off'}`}
          onClick={() => onToggle(alarm.id)}
          aria-label={alarm.enabled ? 'アラームをオフ' : 'アラームをオン'}
        >
          {alarm.enabled ? 'ON' : 'OFF'}
        </button>
        <button
          className="delete-btn"
          onClick={() => onDelete(alarm.id)}
          aria-label="削除"
        >
          ×
        </button>
      </div>
    </div>
  );
}

export function Home() {
  const [alarms, setAlarms] = useState<Alarm[]>(() => loadAlarms());
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [notifStatus, setNotifStatus] = useState<'idle' | 'requesting' | 'granted' | 'denied'>('idle');
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'ok' | 'error'>('idle');

  // 新規アラームフォームの状態
  const [newTime, setNewTime] = useState('07:00');
  const [newDays, setNewDays] = useState<number[]>([]);
  const [newReps, setNewReps] = useState(10);
  const [showForm, setShowForm] = useState(false);

  // 通知許可状態を確認
  useEffect(() => {
    // iOS Safariの通常タブではNotificationが未定義のためガードする
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      setNotifStatus('granted');
      // 既存のsubscriptionを取得
      navigator.serviceWorker.ready.then(reg => {
        reg.pushManager.getSubscription().then(sub => {
          if (sub) setSubscription(sub);
        });
      });
    } else if (Notification.permission === 'denied') {
      setNotifStatus('denied');
    }
  }, []);

  // SWからのALARM_TRIGGEREDメッセージを受信
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const handler = (event: MessageEvent<{ type: string }>) => {
      if (event.data?.type === 'ALARM_TRIGGERED') {
        window.location.hash = '#alarm';
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, []);

  async function handleRequestNotification() {
    setNotifStatus('requesting');
    try {
      const sub = await registerPush();
      setSubscription(sub);
      setNotifStatus('granted');
      await syncToWorker(sub, alarms);
    } catch {
      setNotifStatus('denied');
    }
  }

  async function syncToWorker(sub: PushSubscription, currentAlarms: Alarm[]) {
    setSyncStatus('syncing');
    try {
      await saveAlarms(sub, currentAlarms);
      setSyncStatus('ok');
    } catch {
      setSyncStatus('error');
    }
  }

  function updateAlarms(next: Alarm[]) {
    setAlarms(next);
    saveAlarmsLocal(next);
    if (subscription) {
      void syncToWorker(subscription, next);
    }
  }

  function handleAddAlarm() {
    const alarm: Alarm = {
      id: generateId(),
      time: newTime,
      days: [...newDays],
      enabled: true,
      task: { type: 'squat', reps: newReps },
    };
    updateAlarms([...alarms, alarm]);
    setShowForm(false);
    setNewDays([]);
  }

  function handleToggle(id: string) {
    updateAlarms(alarms.map(a => a.id === id ? { ...a, enabled: !a.enabled } : a));
  }

  function handleDelete(id: string) {
    updateAlarms(alarms.filter(a => a.id !== id));
  }

  function toggleDay(day: number) {
    setNewDays(prev =>
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day],
    );
  }

  async function handleTestPush() {
    if (!subscription) return;
    try {
      await sendTestPush(subscription);
      alert('テストPushを送信しました');
    } catch (e) {
      alert(`失敗: ${e}`);
    }
  }

  return (
    <div className="home">
      <header className="home-header">
        <h1 className="home-title">🐦 earlyBird</h1>
        <p className="home-subtitle">筋トレしないと止まらない目覚まし</p>
      </header>

      {/* 通知許可バナー */}
      {notifStatus !== 'granted' && (
        <div className="banner">
          {typeof Notification === 'undefined' ? (
            // iOS Safari通常タブ：Notification未対応のため案内を表示
            <p className="banner-text">
              iOSでアラームを受け取るには、Safari の「共有」→「ホーム画面に追加」でインストールしてください。
            </p>
          ) : notifStatus === 'denied' ? (
            <p className="banner-text error">
              通知がブロックされています。ブラウザ設定から許可してください。
            </p>
          ) : (
            <>
              <p className="banner-text">
                アラームを受け取るには通知の許可が必要です
              </p>
              <button
                className="btn-primary"
                onClick={handleRequestNotification}
                disabled={notifStatus === 'requesting'}
              >
                {notifStatus === 'requesting' ? '許可中...' : '通知を許可する'}
              </button>
            </>
          )}
        </div>
      )}

      {/* アラーム一覧 */}
      <div className="alarm-list">
        {alarms.length === 0 && (
          <p className="empty-text">アラームがありません</p>
        )}
        {alarms.map(alarm => (
          <AlarmCard
            key={alarm.id}
            alarm={alarm}
            onToggle={handleToggle}
            onDelete={handleDelete}
          />
        ))}
      </div>

      {/* アラーム追加フォーム */}
      {showForm ? (
        <div className="form-card">
          <h2 className="form-title">新しいアラーム</h2>

          <label className="form-label">
            起床時刻
            <input
              type="time"
              className="form-input"
              value={newTime}
              onChange={e => setNewTime(e.target.value)}
            />
          </label>

          <div className="form-label">
            繰り返し（未選択 = 毎日）
            <div className="day-picker">
              {DAY_LABELS.map((label, i) => (
                <button
                  key={i}
                  className={`day-btn ${newDays.includes(i) ? 'selected' : ''}`}
                  onClick={() => toggleDay(i)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <label className="form-label">
            スクワット回数: {newReps}回
            <input
              type="range"
              min={5}
              max={50}
              step={5}
              value={newReps}
              onChange={e => setNewReps(Number(e.target.value))}
              className="form-range"
            />
          </label>

          <div className="form-actions">
            <button className="btn-secondary" onClick={() => setShowForm(false)}>
              キャンセル
            </button>
            <button className="btn-primary" onClick={handleAddAlarm}>
              追加
            </button>
          </div>
        </div>
      ) : (
        <button className="btn-add" onClick={() => setShowForm(true)}>
          + アラームを追加
        </button>
      )}

      {/* ステータス表示 */}
      <div className="footer">
        {syncStatus === 'syncing' && <span className="status-syncing">同期中...</span>}
        {syncStatus === 'ok' && <span className="status-ok">✓ 同期済み</span>}
        {syncStatus === 'error' && <span className="status-error">同期エラー</span>}

        {/* 開発用テストボタン */}
        {import.meta.env.DEV && subscription && (
          <button className="btn-ghost" onClick={handleTestPush}>
            テストPush送信
          </button>
        )}
      </div>
    </div>
  );
}
