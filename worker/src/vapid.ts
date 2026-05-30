import type { PushSubscriptionJSON } from '../../shared/types.js';

/** Web CryptoでVAPID JWT（ES256）を生成してPush送信するためのヘルパー */

const AUDIENCE_REGEX = /^https?:\/\/[^/]+/;

function base64urlToUint8Array(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), '=');
  const raw = atob(padded);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function uint8ArrayToBase64url(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function importPrivateKey(dBase64url: string): Promise<CryptoKey> {
  // JWK形式でインポート
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: dBase64url,
    // JWK importにはx,yも必要 — 公開鍵x,yはenv.VAPID_PUBLIC_KEYから逆算するより、
    // dと公開鍵の両方をenvに持つのが確実だが、ここでは公開鍵から x,y を取り出す。
    // ただし今回は秘密鍵のみのsign用なのでx/yはダミーでも動く環境もあるが、
    // 確実のために公開鍵バイト列から x,y を取り出して渡す。
    ext: true,
    key_ops: ['sign'],
  };
  // x, y を後から設定するため、importKeyを2段階で行う
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

async function buildVapidJwt(
  subject: string,
  audience: string,
  privateKeyD: string,
  publicKeyBase64url: string,
): Promise<{ authorization: string; cryptoKey: string }> {
  // ヘッダー・ペイロード
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: now + 12 * 3600,
    sub: subject,
  };

  const encode = (obj: object) =>
    uint8ArrayToBase64url(new TextEncoder().encode(JSON.stringify(obj)));

  const sigInput = `${encode(header)}.${encode(payload)}`;

  // 公開鍵から x, y を取り出してJWKに設定してからインポート
  const pubBytes = base64urlToUint8Array(publicKeyBase64url);
  // uncompressed P-256: 0x04 + 32 bytes x + 32 bytes y
  const x = uint8ArrayToBase64url(pubBytes.slice(1, 33));
  const y = uint8ArrayToBase64url(pubBytes.slice(33, 65));

  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: privateKeyD,
    x,
    y,
    ext: true,
    key_ops: ['sign'],
  };

  const privKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const sigBytes = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    privKey,
    new TextEncoder().encode(sigInput),
  );

  const jwt = `${sigInput}.${uint8ArrayToBase64url(new Uint8Array(sigBytes))}`;

  return {
    authorization: `vapid t=${jwt},k=${publicKeyBase64url}`,
    cryptoKey: `p256ecdsa=${publicKeyBase64url}`,
  };
}

export type PushEnv = {
  VAPID_PRIVATE_KEY_D: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_SUBJECT: string;
};

export async function sendPush(
  subscription: PushSubscriptionJSON,
  payload: string,
  env: PushEnv,
): Promise<Response> {
  const endpoint = subscription.endpoint;
  const audience = endpoint.match(AUDIENCE_REGEX)?.[0];
  if (!audience) throw new Error(`Invalid endpoint: ${endpoint}`);

  const { authorization } = await buildVapidJwt(
    env.VAPID_SUBJECT,
    audience,
    env.VAPID_PRIVATE_KEY_D,
    env.VAPID_PUBLIC_KEY,
  );

  // 暗号化はweb-push標準（HTTP Encrypted Content-Encoding）が必要だが、
  // Cloudflare WorkersにはWeb Cryptoがあるため手動実装が必要。
  // 簡略化のため、payloadをJSONテキストとして平文送信する（対応ブラウザ側で復号不要）。
  // ただし真のペイロード暗号化（aes128gcm）は後続で対応。
  // 今は空payloadのpingのみを送り、通知内容はSW側で固定メッセージとする。

  const body = new TextEncoder().encode(payload);

  const headers: HeadersInit = {
    Authorization: authorization,
    TTL: '86400',
    Urgency: 'high',
  };

  if (payload) {
    // 暗号化なし平文（Chromeは拒否する場合があるため本番は暗号化が必要）
    // MVP段階では空pushを送りSW側で通知を出す
    headers['Content-Type'] = 'application/octet-stream';
    headers['Content-Encoding'] = 'aes128gcm';
  }

  return fetch(endpoint, {
    method: 'POST',
    headers,
    body: payload ? body : undefined,
  });
}

/** 空のpingを送る（SWがpushイベントを受けて固定通知を出す） */
export async function sendPushPing(
  subscription: PushSubscriptionJSON,
  env: PushEnv,
): Promise<{ ok: boolean; status: number }> {
  const endpoint = subscription.endpoint;
  const audience = endpoint.match(AUDIENCE_REGEX)?.[0];
  if (!audience) return { ok: false, status: 0 };

  const { authorization } = await buildVapidJwt(
    env.VAPID_SUBJECT,
    audience,
    env.VAPID_PRIVATE_KEY_D,
    env.VAPID_PUBLIC_KEY,
  );

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      TTL: '86400',
      Urgency: 'high',
      'Content-Length': '0',
    },
  });

  return { ok: res.ok, status: res.status };
}
