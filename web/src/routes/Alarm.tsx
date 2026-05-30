import { useState, useEffect, useCallback, useRef } from 'react';
import { startAlarm, stopAlarm } from '../lib/audio.js';
import {
  requestMotionPermission,
  startRepCounter,
  stopRepCounter,
  debugIncrementRep,
} from '../lib/repCounter.js';
import { sendAck } from '../lib/api.js';
import { loadAlarms } from '../lib/storage.js';
import './Alarm.css';

const TARGET_REPS_DEFAULT = 10;

type Phase = 'tap-to-start' | 'exercising' | 'done' | 'error';

export function Alarm({ onDismiss }: { onDismiss: () => void }) {
  const [phase, setPhase] = useState<Phase>('tap-to-start');
  const [reps, setReps] = useState(0);
  const [targetReps, setTargetReps] = useState(TARGET_REPS_DEFAULT);
  const [errorMsg, setErrorMsg] = useState('');
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const subscriptionRef = useRef<PushSubscription | null>(null);
  const alarmIdRef = useRef<string | null>(null);

  // アラームIDとtargetRepsを設定から取得
  useEffect(() => {
    const alarms = loadAlarms();
    const activeAlarm = alarms.find(a => a.enabled);
    if (activeAlarm) {
      setTargetReps(activeAlarm.task.reps);
      alarmIdRef.current = activeAlarm.id;
    }
    // subscriptionを取得
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(reg => {
        reg.pushManager.getSubscription().then(sub => {
          subscriptionRef.current = sub;
        });
      });
    }
  }, []);

  // 完了後のACK送信とアラーム停止
  const handleComplete = useCallback(async () => {
    setPhase('done');
    stopAlarm();
    stopRepCounter();

    if (wakeLockRef.current) {
      await wakeLockRef.current.release();
      wakeLockRef.current = null;
    }

    // Workerにack送信
    if (subscriptionRef.current && alarmIdRef.current) {
      try {
        await sendAck(subscriptionRef.current, alarmIdRef.current);
      } catch {
        // ACK失敗してもUIは完了にする
      }
    }
  }, []);

  // 「タップして起きる」ボタン
  async function handleTapToStart() {
    // (a) Web Audio 大音量ループ開始（ユーザー操作起点でiOS制限を回避）
    startAlarm();

    // (b) DeviceMotion権限取得（iOS 13+）
    const granted = await requestMotionPermission();
    if (!granted) {
      setErrorMsg('加速度センサーの許可が必要です。設定 > プライバシー > モーションと フィットネス を確認してください。');
      setPhase('error');
      return;
    }

    // (c) Wake Lock取得（画面を消さない）
    if ('wakeLock' in navigator) {
      try {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
      } catch {
        // Wake Lock取得失敗は非致命的
      }
    }

    setPhase('exercising');
    setReps(0);

    startRepCounter((count) => {
      setReps(count);
      if (count >= targetReps) {
        void handleComplete();
      }
    });
  }

  // コンポーネントアンマウント時にクリーンアップ
  useEffect(() => {
    return () => {
      stopAlarm();
      stopRepCounter();
      if (wakeLockRef.current) {
        void wakeLockRef.current.release();
      }
    };
  }, []);

  if (phase === 'done') {
    return (
      <div className="alarm-screen done">
        <div className="done-content">
          <div className="done-icon">✓</div>
          <h1 className="done-title">おはよう！</h1>
          <p className="done-sub">スクワット {targetReps}回 完了！</p>
          <button className="btn-dismiss" onClick={onDismiss}>
            閉じる
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="alarm-screen error">
        <div className="error-content">
          <h2>センサーエラー</h2>
          <p>{errorMsg}</p>
          <button className="btn-dismiss" onClick={onDismiss}>
            閉じる
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'tap-to-start') {
    return (
      <div className="alarm-screen tap">
        <button className="tap-btn" onClick={handleTapToStart}>
          <span className="tap-icon">⏰</span>
          <span className="tap-label">タップして起きる</span>
        </button>
        <p className="tap-hint">タップで音が鳴り始めます</p>
      </div>
    );
  }

  // exercising
  const progress = Math.min(reps / targetReps, 1);

  return (
    <div className="alarm-screen exercising">
      <p className="exercise-instruction">
        スマホを持って<br />スクワット！
      </p>

      <div className="rep-counter">
        <svg className="progress-ring" viewBox="0 0 120 120">
          <circle
            className="progress-track"
            cx="60" cy="60" r="52"
            fill="none" strokeWidth="8"
          />
          <circle
            className="progress-fill"
            cx="60" cy="60" r="52"
            fill="none" strokeWidth="8"
            strokeDasharray={`${2 * Math.PI * 52}`}
            strokeDashoffset={`${2 * Math.PI * 52 * (1 - progress)}`}
            strokeLinecap="round"
          />
        </svg>
        <div className="rep-numbers">
          <span className="rep-current">{reps}</span>
          <span className="rep-slash">/</span>
          <span className="rep-target">{targetReps}</span>
        </div>
      </div>

      <p className="rep-remain">
        あと {Math.max(targetReps - reps, 0)} 回！
      </p>

      {/* PC/開発環境用デバッグボタン */}
      {import.meta.env.DEV && (
        <button
          className="btn-debug"
          onClick={() => debugIncrementRep((count) => {
            setReps(count);
            if (count >= targetReps) void handleComplete();
          })}
        >
          デバッグ: +1回
        </button>
      )}
    </div>
  );
}
