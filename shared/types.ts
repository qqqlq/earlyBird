// Web Push Subscription JSON（DOMに依存しない独自定義）
export type PushSubscriptionJSON = {
  endpoint: string;
  expirationTime?: number | null;
  keys?: {
    p256dh?: string;
    auth?: string;
    [key: string]: string | undefined;
  };
};

export type Alarm = {
  id: string;
  time: string;       // "HH:MM"
  days: number[];     // 0=日..6=土。空=毎日
  enabled: boolean;
  task: { type: 'squat'; reps: number };
};

export type FiringState = {
  alarmId: string;
  startedAt: number;  // Unix ms
};

export type StoredEntry = {
  subscription: PushSubscriptionJSON;
  tz: string;         // IANA tz 例 "Asia/Tokyo"
  alarms: Alarm[];
  firing: FiringState | null;
};

// API リクエスト/レスポンス型
export type SaveAlarmsRequest = {
  subscription: PushSubscriptionJSON;
  tz: string;
  alarms: Alarm[];
};

export type AckRequest = {
  subscriptionEndpoint: string;
  alarmId: string;
};

export type TestPushRequest = {
  subscriptionEndpoint: string;
};

export type ApiResponse<T = null> = {
  ok: true;
  data: T;
} | {
  ok: false;
  error: string;
};
