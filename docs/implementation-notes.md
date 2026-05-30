# earlyBird 実装メモ（自分向け備忘録）

> 「目覚ましかけても二度寝してしまう」→「スクワットしないと止まらない目覚まし」を作った記録。
> 技術的なことを忘れたときのために、どこで何をしているか・なぜそうなっているかを詳しく書いてある。

---

## 全体の構成（ざっくり）

```
earlyBird/
  web/       ← スマホで表示するWebアプリ（React）
  worker/    ← サーバー側（Cloudflare Workers）
  shared/    ← webとworkerで共通して使うコード
  docs/      ← このドキュメント
```

**「アプリ」「サーバー」に分かれている理由:**  
ブラウザは時刻に合わせて勝手に何かを起動する機能（信頼できるアラームAPI）を持っていない。アプリを閉じた状態でも指定時刻にスマホに通知を送るには、インターネット上で常に動いているサーバーが必要。

---

## フォルダ別・ファイル別の説明

### `shared/` — フロントとサーバーで共通のコード

#### `shared/types.ts` — データの型定義

アプリ全体で使うデータの「形」を定義したファイル。TypeScriptでは型を先に決めておくと、間違ったデータを渡したときにエラーを出してくれる。

```typescript
type Alarm = {
  id: string;       // UUID（アラームの識別子）
  time: string;     // "07:30" のような文字列
  days: number[];   // [1, 2, 3, 4, 5] = 月〜金。空配列 = 毎日
  enabled: boolean; // オン/オフ
  task: { type: 'squat'; reps: number }; // スクワット○回
};
```

`FiringState` はサーバー側でアラームが「鳴動中かどうか」を管理するための状態。

```typescript
type FiringState = {
  alarmId: string;    // どのアラームが鳴っているか
  startedAt: number;  // いつ鳴り始めたか（Unix時間ミリ秒）
};
```

`StoredEntry` がCloudflare KV（後述）に保存される1ユーザー分のまとまり。

`PushSubscriptionJSON` はブラウザが発行する「このデバイスへの通知の宛先」情報。本来はブラウザのDOM型だが、WorkerはブラウザAPIを持たないので自分で定義している。

---

#### `shared/alarmMatch.ts` — 「今このアラームを鳴らすべきか」判定

サーバーは毎分動くが、ユーザーは日本にいるのにサーバーはロンドン時間（UTC）で動いている。「07:30に鳴らす」は「日本の07:30」なので、UTC→日本時間の変換が必要。

```typescript
export function matchAlarms(now: Date, alarms: Alarm[], tz: string): Alarm[] {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,           // 例: "Asia/Tokyo"
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  // partsから時・分・曜日を取り出してアラームの設定と比較
  ...
}
```

`Intl.DateTimeFormat` はJavaScript標準の国際化APIで、タイムゾーンを指定して日時のフォーマットができる。外部ライブラリなしでこれができるのはありがたい。

引数を `Date` と `Alarm[]` だけにして、外部状態に依存しない**純粋関数**にしてある理由：テストが書きやすく、「この入力ならこの出力」が保証できるから。

---

### `worker/` — Cloudflare Workersで動くサーバー

Cloudflare Workers は「エッジコンピューティング」と呼ばれる仕組みで、Cloudflareのサーバー（世界中に300箇所以上）の上でコードが動く。通常のNode.jsサーバーとは違い、1リクエストあたり数ミリ秒で終わる小さな処理に特化している。無料枠で毎分のCronが動かせるのが今回採用した最大の理由。

#### `worker/wrangler.toml` — Workerの設定ファイル

```toml
name = "earlybird-worker"
main = "src/index.ts"

[triggers]
crons = ["* * * * *"]          # 毎分実行

[[kv_namespaces]]
binding = "ALARMS_KV"
id = "fd35f7003e424c6191d34dd3ea361007"       # 本番KV
preview_id = "ea8281ab2b404ce2b60acd4cd4382fb1"  # 開発用KV

[vars]
VAPID_PUBLIC_KEY = "BClgVC_..."  # 公開鍵（秘密情報ではない）
FRONT_ORIGIN = "https://earlybird.nodewalker.app"
ALARM_TIMEOUT_MINUTES = "30"    # 30分経っても完了しなければ自動停止
```

**VAPID秘密鍵はwrangler secretで管理（コードには書かない）:**
```bash
wrangler secret put VAPID_PRIVATE_KEY_D   # ← 秘密鍵のd値
wrangler secret put VAPID_SUBJECT         # ← mailto:your@email.com
```

---

#### `worker/src/vapid.ts` — Push通知を送るための署名処理

**VAPIDとは？**  
Web Push（ブラウザへのプッシュ通知）を送るとき、「このサーバーは正しいサーバーですよ」と証明するための仕組み。公開鍵・秘密鍵のペアを使う。

**なぜ自分で実装しているのか？**  
Node.js用の `web-push` ライブラリが便利だが、Cloudflare Workersは Node.js ではなく独自の実行環境なので動かない。代わりにブラウザ互換の `Web Crypto API` を使って署名処理を手書きしている。

```typescript
// JWTの生成フロー
// 1. ヘッダーとペイロードをJSON→Base64URL変換
const sigInput = `${encode(header)}.${encode(payload)}`;

// 2. ECDSA P-256で秘密鍵をインポート（公開鍵のx,yも必要）
const privKey = await crypto.subtle.importKey('jwk', jwk, ...);

// 3. 署名してJWT完成
const jwt = `${sigInput}.${uint8ArrayToBase64url(sigBytes)}`;
```

**sendPushPing:**  
ペイロード（中身）なしの空のPingを送る関数。SWが `push` イベントを受けたら固定メッセージの通知を出す仕組みにしている。将来的にはメッセージを暗号化して送る（aes128gcm）必要がある。

---

#### `worker/src/index.ts` — APIエンドポイントとCron処理

**APIエンドポイント:**

| エンドポイント | 役割 |
|---|---|
| `POST /alarms` | アラーム設定とsubscription（通知の宛先）を保存 |
| `POST /ack` | スクワット完了を受け取りアラームを停止 |
| `POST /test-push` | 開発確認用。即座にPush通知を送る |

**KVのキー設計:**  
subscriptionのendpoint（長いURL）をBase64してKVキーにしている：
```typescript
function endpointToKey(endpoint: string): string {
  return 'sub:' + btoa(endpoint).replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
}
```

**Cronの処理フロー:**

```
毎分実行
  ↓
全KVエントリを走査
  ↓
[既にfiring中のエントリ]
  → タイムアウト(30分)超過？ → firingを解除して終了
  → まだ時間内    → Push再送
[まだfiring中でないエントリ]
  → matchAlarms()で今この分に鳴らすべきか確認
  → 該当あり → firingをセット → Push送信
  → 該当なし → 何もしない
  ↓
Pushが404/410で返ってきた → subscriptionが無効 → KVから削除
```

**なぜfiringを再送するのか？**  
通知1回だけだと「無視してそのまま二度寝」ができてしまう。スクワットを完了して `/ack` を送るまで毎分通知を飛ばし続ける。30分でタイムアウト。

---

### `web/` — スマホで表示するPWA

#### `web/vite.config.ts` — ビルド設定

```typescript
VitePWA({
  strategies: 'injectManifest',  // カスタムSWを使う
  manifest: {
    display: 'standalone',       // ホーム画面追加したときにアドレスバーを隠す
  },
})
```

`@shared/*` のalias設定で `import ... from '@shared/types.js'` のように書ける。

---

#### `web/src/sw.ts` — Service Worker

**Service Workerとは？**  
ブラウザとネットワークの間に置かれる「中継プロキシ」みたいなもの。アプリが閉じていても動き続けられる。

```typescript
// push通知を受信 → 通知を表示
self.addEventListener('push', () => {
  self.registration.showNotification('earlyBird ⏰', {
    requireInteraction: true,    // タップしないと消えない
    vibrate: [500, 200, 500, 200, 500],  // Android: バイブパターン
  });
});

// 通知タップ → アプリを前面に出す
self.addEventListener('notificationclick', (event) => {
  // 既にアプリが開いていればそのウィンドウをfocusしてメッセージを送る
  // 開いていなければ /alarm を開く
});
```

---

#### `web/src/App.tsx` — ルーティング

シンプルなハッシュベースのルーティング。`window.location.hash` が `#alarm` なら筋トレ画面、それ以外はホーム画面。

---

#### `web/src/routes/Home.tsx` — アラーム設定画面

**iOSのSafari通常タブでは `Notification` が `undefined`** になるため、必ずガードが必要：
```typescript
useEffect(() => {
  if (typeof Notification === 'undefined') return;  // ← このガードが重要
  if (Notification.permission === 'granted') { ... }
}, []);
```

未定義の場合はバナーで「ホーム画面に追加してください」と案内する。

**アラームの保存先が2箇所ある理由:**  
- `localStorage`（端末内）: アプリを開いたときに素早く読み込むため
- Cloudflare KV（サーバー）: Cronがアラーム時刻を確認するため

---

#### `web/src/routes/Alarm.tsx` — アラーム・筋トレ画面

4つのフェーズがある：

| フェーズ | 表示 |
|---|---|
| `tap-to-start` | 大きな丸ボタン「タップして起きる」 |
| `exercising` | スクワット回数の円グラフと残り回数 |
| `done` | 「おはよう！」完了画面 |
| `error` | センサー権限エラー |

**「タップして起きる」ボタンを押したときの動作:**

```typescript
async function handleTapToStart() {
  // (a) Web Audioでアラーム音を鳴らす
  //     ← ユーザー操作のイベント内から呼ばないとiOSで音が出ない（実証済み）
  startAlarm();

  // (b) DeviceMotion（加速度センサー）の権限を取得
  //     ← iOS 13+はユーザー操作起点から呼ぶ必要がある
  const granted = await requestMotionPermission();

  // (c) Wake Lockで画面を消さない
  wakeLockRef.current = await navigator.wakeLock.request('screen');

  // センサー監視を開始
  startRepCounter((count) => {
    setReps(count);
    if (count >= targetReps) handleComplete();
  });
}
```

**完了時の処理:**
```typescript
async function handleComplete() {
  stopAlarm();
  stopRepCounter();
  wakeLockRef.current?.release();
  await sendAck(subscription, alarmId);  // Workerに完了を通知→再送停止
}
```

**円グラフの仕組み（SVG）:**
```
strokeDasharray  = 円周 = 2π × 半径52 ≒ 326.7
strokeDashoffset = 円周 × (1 - 進捗率)
→ 0回/10回のとき: offset = 326.7（全部ずらす = 何も表示されない）
→ 10回/10回のとき: offset = 0（全部表示 = 完成）
```

---

#### `web/src/lib/repCounter.ts` — スクワット検出

```typescript
motionHandler = (event: DeviceMotionEvent) => {
  const ay = Math.abs(acc.y ?? 0);  // 上下方向の大きさ

  // しきい値(12 m/s²)を超えたら1回カウント
  // 前回から600ms以上経過していないと無視（連続検出防止）
  if (ay > threshold && now - lastRepTime > minInterval) {
    repCount++;
    onRep(repCount);
  }
};
```

しきい値 `12 m/s²` の根拠：重力加速度が約 9.8 m/s²、それより大きな値がスクワットの立ち上がり動作で発生する。体型・スマホの持ち方・動作の速さで変わるため、将来的にはキャリブレーション機能が必要かもしれない。

**iOSの権限:**  
iOS 13以降は `DeviceMotionEvent.requestPermission()` をユーザー操作イベントの中から呼ぶ必要がある。「タップして起きる」ボタンの中でまとめて許可を取っているのはこのため。

---

#### `web/src/lib/audio.ts` — アラーム音生成

スマホにMP3を置くよりも、Web Audio APIで音を合成するほうが依存ファイルが不要。

```typescript
// 880Hz と 1320Hz の正弦波を合成
data[i] = envelope * (
  0.6 * Math.sin(2 * Math.PI * 880 * t) +
  0.4 * Math.sin(2 * Math.PI * 1320 * t)
);
```

生成した0.8秒のバッファを `loop: true` でループ再生。AudioContextはユーザー操作内から生成することでiOSの自動再生制限を回避（実機で動作確認済み）。

---

## セキュリティ

### リポジトリがpublicでも安全な理由

- **KV namespace ID・preview_id**: 単なるDB名。APIトークンなしではアクセス不可。gitにコミットしてOK
- **VAPID公開鍵**: 公開前提の鍵。コードに書いてOK
- **VAPID秘密鍵**: `wrangler secret` でCloudflareの暗号化ストレージに保存。コードには存在しない
- **APIエンドポイント**: 現状は公開状態だが、Cloudflare Accessで保護予定（TODO）

### CORS設定
```typescript
'Access-Control-Allow-Origin': env.FRONT_ORIGIN  // 自分のサイトのURLだけ許可
```

---

## デプロイ手順メモ

### 初回セットアップ（完了済み）

```bash
# 1. KVネームスペース作成
cd worker
npx wrangler kv namespace create ALARMS_KV
npx wrangler kv namespace create ALARMS_KV --preview
# → 出力されたIDをwrangler.tomlに書き込む

# 2. VAPID秘密鍵を登録
npx wrangler secret put VAPID_PRIVATE_KEY_D
npx wrangler secret put VAPID_SUBJECT

# 3. Workerをデプロイ
npx wrangler deploy

# 4. フロントをビルド・デプロイ
cd ../web
echo "VITE_WORKER_URL=https://earlybird-worker.nodewalker.workers.dev" > .env.local
npm run build
npx wrangler pages deploy dist --project-name earlybird
```

### 更新時のデプロイ（コード変更後）

```bash
# Worker更新
cd worker && npx wrangler deploy

# フロント更新
cd web && npm run build && npx wrangler pages deploy dist --project-name earlybird
```

---

## iOSでの使い方（運用メモ）

1. **マナースイッチをOFF**にして寝る（これが必須）
2. Safariで `earlybird.nodewalker.app` を開く
3. 共有ボタン → 「ホーム画面に追加」→「Webアプリとして開く: ON」
4. ホーム画面のアイコンからアプリを開く
5. 「通知を許可する」をタップ
6. アラームを設定して完了
7. アラーム時刻にPush通知が来る → タップ → 「タップして起きる」を押す → 鳴り始める → スクワットで停止

---

## 今後やること

| 優先度 | 内容 |
|---|---|
| 高 | Cloudflare AccessでAPIを保護 |
| 中 | スクワット検出しきい値のキャリブレーション |
| 中 | Push Payload暗号化（aes128gcm） |
| 低 | カメラスクワット認識（MediaPipe） |
| 低 | Capacitor + Androidネイティブ化 |
