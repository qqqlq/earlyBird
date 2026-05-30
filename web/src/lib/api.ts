import { WORKER_URL, VAPID_PUBLIC_KEY } from './constants.js';
import type { Alarm, ApiResponse, SaveAlarmsRequest } from '@shared/types.js';

function base64urlToUint8Array(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), '=');
  const raw = atob(padded);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

export async function registerPush(): Promise<PushSubscription> {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    // Uint8Array<ArrayBufferLike> → ArrayBuffer にコピーしてBufferSourceに適合させる
    const keyBytes = base64urlToUint8Array(VAPID_PUBLIC_KEY);
    const keyBuffer = keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer;
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBuffer,
    });
  }
  return sub;
}

export async function saveAlarms(
  subscription: PushSubscription,
  alarms: Alarm[],
): Promise<void> {
  const body: SaveAlarmsRequest = {
    subscription: subscription.toJSON() as Required<typeof body.subscription>,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    alarms,
  };
  const res = await fetch(`${WORKER_URL}/alarms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json() as ApiResponse;
  if (!data.ok) throw new Error(data.error);
}

export async function sendAck(
  subscription: PushSubscription,
  alarmId: string,
): Promise<void> {
  const res = await fetch(`${WORKER_URL}/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscriptionEndpoint: subscription.endpoint,
      alarmId,
    }),
  });
  const data = await res.json() as ApiResponse;
  if (!data.ok) throw new Error(data.error);
}

export async function sendTestPush(subscription: PushSubscription): Promise<void> {
  const res = await fetch(`${WORKER_URL}/test-push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscriptionEndpoint: subscription.endpoint }),
  });
  const data = await res.json() as ApiResponse;
  if (!data.ok) throw new Error(data.error);
}
