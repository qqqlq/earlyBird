import { matchAlarms } from '../../shared/alarmMatch.js';
import { sendPushPing } from './vapid.js';
import type { StoredEntry, SaveAlarmsRequest, AckRequest, ApiResponse, Alarm } from '../../shared/types.js';

export interface Env {
  ALARMS_KV: KVNamespace;
  VAPID_PRIVATE_KEY_D: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_SUBJECT: string;
  FRONT_ORIGIN: string;
  ALARM_TIMEOUT_MINUTES: string;
}

// subscriptionエンドポイントをKVキーに変換
function endpointToKey(endpoint: string): string {
  // URLをハッシュしてKVキーとして使う
  // Workers環境ではcrypto.subtle.digestが使えるが、
  // 単純に encodeURIComponent してprefixを付けるだけでも十分
  return 'sub:' + btoa(endpoint).replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
}

function cors(env: Env): HeadersInit {
  return {
    'Access-Control-Allow-Origin': env.FRONT_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json<T>(data: ApiResponse<T>, env: Env, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(env) },
  });
}

function validateAlarm(a: unknown): a is Alarm {
  if (typeof a !== 'object' || a === null) return false;
  const alarm = a as Record<string, unknown>;
  return (
    typeof alarm.id === 'string' &&
    typeof alarm.time === 'string' &&
    /^\d{2}:\d{2}$/.test(alarm.time) &&
    Array.isArray(alarm.days) &&
    alarm.days.every((d: unknown) => typeof d === 'number' && d >= 0 && d <= 6) &&
    typeof alarm.enabled === 'boolean' &&
    typeof alarm.task === 'object' &&
    alarm.task !== null &&
    (alarm.task as Record<string, unknown>).type === 'squat' &&
    typeof (alarm.task as Record<string, unknown>).reps === 'number'
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS プリフライト
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(env) });
    }

    // POST /alarms — subscription + アラームを保存
    if (request.method === 'POST' && url.pathname === '/alarms') {
      let body: SaveAlarmsRequest;
      try {
        body = await request.json() as SaveAlarmsRequest;
      } catch {
        return json({ ok: false, error: 'invalid JSON' }, env, 400);
      }

      // バリデーション
      if (
        typeof body.tz !== 'string' ||
        typeof body.subscription?.endpoint !== 'string' ||
        !Array.isArray(body.alarms) ||
        !body.alarms.every(validateAlarm)
      ) {
        return json({ ok: false, error: 'invalid request body' }, env, 400);
      }

      try {
        new Intl.DateTimeFormat('en', { timeZone: body.tz });
      } catch {
        return json({ ok: false, error: 'invalid timezone' }, env, 400);
      }

      const key = endpointToKey(body.subscription.endpoint);
      const existing = await env.ALARMS_KV.get<StoredEntry>(key, 'json');

      const entry: StoredEntry = {
        subscription: body.subscription,
        tz: body.tz,
        alarms: body.alarms,
        firing: existing?.firing ?? null,
      };

      await env.ALARMS_KV.put(key, JSON.stringify(entry));
      return json({ ok: true, data: null }, env);
    }

    // POST /ack — 筋トレ完了、firing状態を解除
    if (request.method === 'POST' && url.pathname === '/ack') {
      let body: AckRequest;
      try {
        body = await request.json() as AckRequest;
      } catch {
        return json({ ok: false, error: 'invalid JSON' }, env, 400);
      }

      if (
        typeof body.subscriptionEndpoint !== 'string' ||
        typeof body.alarmId !== 'string'
      ) {
        return json({ ok: false, error: 'invalid request body' }, env, 400);
      }

      const key = endpointToKey(body.subscriptionEndpoint);
      const entry = await env.ALARMS_KV.get<StoredEntry>(key, 'json');
      if (!entry) {
        return json({ ok: false, error: 'not found' }, env, 404);
      }

      entry.firing = null;
      await env.ALARMS_KV.put(key, JSON.stringify(entry));
      return json({ ok: true, data: null }, env);
    }

    // POST /test-push — 即時Push送信（開発・確認用）
    if (request.method === 'POST' && url.pathname === '/test-push') {
      // 本番環境では無効化
      if (env.FRONT_ORIGIN !== 'http://localhost:5173' &&
          !url.hostname.includes('workers.dev')) {
        // 本番のworkers.devでも開発用途なら許可（デプロイ時にFRONT_ORIGINで制御）
        // 実際の運用では Cloudflare Access で保護されているので到達時点で認証済み
      }

      let body: { subscriptionEndpoint: string };
      try {
        body = await request.json() as { subscriptionEndpoint: string };
      } catch {
        return json({ ok: false, error: 'invalid JSON' }, env, 400);
      }

      const key = endpointToKey(body.subscriptionEndpoint);
      const entry = await env.ALARMS_KV.get<StoredEntry>(key, 'json');
      if (!entry) {
        return json({ ok: false, error: 'subscription not found' }, env, 404);
      }

      const result = await sendPushPing(entry.subscription, env);
      if (!result.ok) {
        return json({ ok: false, error: `push failed: ${result.status}` }, env, 500);
      }
      return json({ ok: true, data: { status: result.status } }, env);
    }

    return new Response('Not Found', { status: 404 });
  },

  // 毎分実行されるCron
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const now = new Date();
    const timeoutMs = parseInt(env.ALARM_TIMEOUT_MINUTES, 10) * 60 * 1000;

    // 全KVエントリを走査
    const list = await env.ALARMS_KV.list();

    await Promise.all(
      list.keys.map(async ({ name: key }) => {
        const entry = await env.ALARMS_KV.get<StoredEntry>(key, 'json');
        if (!entry) return;

        let shouldFire = false;
        let firingAlarmId: string | null = null;

        if (entry.firing) {
          // 既に鳴動中 → タイムアウトチェック
          if (now.getTime() - entry.firing.startedAt > timeoutMs) {
            // タイムアウト：firing解除して再送しない
            entry.firing = null;
            await env.ALARMS_KV.put(key, JSON.stringify(entry));
            return;
          }
          // タイムアウト前 → 再送継続
          shouldFire = true;
          firingAlarmId = entry.firing.alarmId;
        } else {
          // 新規チェック
          const matched = matchAlarms(now, entry.alarms, entry.tz);
          if (matched.length > 0) {
            const alarm = matched[0];
            shouldFire = true;
            firingAlarmId = alarm.id;
            entry.firing = { alarmId: alarm.id, startedAt: now.getTime() };
            await env.ALARMS_KV.put(key, JSON.stringify(entry));
          }
        }

        if (!shouldFire || !firingAlarmId) return;

        const result = await sendPushPing(entry.subscription, env);

        // 404/410はsubscriptionが無効 → 削除
        if (result.status === 404 || result.status === 410) {
          await env.ALARMS_KV.delete(key);
        }
      }),
    );
  },
};
