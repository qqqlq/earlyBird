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

  const parts = fmt.formatToParts(now);
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
main = "src/index.ts"          # エントリーポイント

[triggers]
crons = ["* * * * *"]          # 毎分実行（cron記法）

[[kv_namespaces]]
binding = "ALARMS_KV"          # コード内で env.ALARMS_KV として使える
id = "REPLACE_WITH_..."        # ← デプロイ前にここを書き換える必要がある

[vars]
VAPID_PUBLIC_KEY = "BClgVC_..."  # 公開鍵（秘密情報ではない）
FRONT_ORIGIN = "https://earlybird.nodewalker.app"
ALARM_TIMEOUT_MINUTES = "30"    # 30分経っても完了しなければ自動停止
```

---

#### `worker/src/vapid.ts` — Push通知を送るための署名処理

**VAPIDとは？**  
Web Push（ブラウザへのプッシュ通知）を送るとき、「このサーバーは正しいサーバーですよ」と証明するための仕組み。公開鍵・秘密鍵のペアを使う。

**なぜ自分で実装しているのか？**  
Node.js用の `web-push` ライブラリが便利だが、Cloudflare Workersは Node.js ではなく独自の実行環境（Miniflare）なので動かない。代わりにブラウザ互換の `Web Crypto API` を使って署名処理を手書きしている。

```typescript
// JWTの生成フロー
// 1. ヘッダー { typ: 'JWT', alg: 'ES256' } と
//    ペイロード { aud: "通知先のURL", exp: "有効期限", sub: "メールアドレス" }
//    をJSON→Base64URL変換して "ヘッダー.ペイロード" の文字列を作る
const sigInput = `${encode(header)}.${encode(payload)}`;

// 2. 秘密鍵（env.VAPID_PRIVATE_KEY_D に入ってるd値）とx,yで
//    ECDSA P-256 の秘密鍵をインポート
const privKey = await crypto.subtle.importKey('jwk', jwk, ...);

// 3. 署名して "ヘッダー.ペイロード.署名" = JWT の完成
const sigBytes = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privKey, sigInput);
const jwt = `${sigInput}.${uint8ArrayToBase64url(new Uint8Array(sigBytes))}`;
```

**Base64URLとは？**  
Base64は英数字+`+/=`だが、URLの中で使うと問題が起きる。Base64URLは`+`→`-`、`/`→`_`、末尾の`=`を除去したバリアント。

**sendPushPing**  
ペイロード（中身）なしの空のPingを送る関数。SWが `push` イベントを受けたら固定メッセージの通知を出す仕組みにしているので、今は空でOK。将来的にはメッセージを暗号化して送る（aes128gcm）必要がある。

---

#### `worker/src/index.ts` — APIエンドポイントとCron処理

**APIエンドポイント:**

| エンドポイント | 役割 |
|---|---|
| `POST /alarms` | アラーム設定とsubscription（通知の宛先）を保存 |
| `POST /ack` | スクワット完了を受け取りアラームを停止 |
| `POST /test-push` | 開発確認用。即座にPush通知を送る |

**KVのキー設計:**  
Cloudflare KV はキー/バリューのシンプルなDB。subscriptionのendpoint（長いURL）をBase64してキーにしている：
```typescript
function endpointToKey(endpoint: string): string {
  return 'sub:' + btoa(endpoint).replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
}
```

**入力バリデーション:**  
`validateAlarm` 関数でリクエストの形が正しいか確認している。外部からのリクエストは信用しないのが基本。タイムゾーンも `new Intl.DateTimeFormat('en', { timeZone: body.tz })` を呼び出してみて例外が出なければ有効、という方法で確認。

**CORSヘッダー:**  
ブラウザはセキュリティのため、異なるドメインへのAPIリクエストをデフォルトでブロックする。`FRONT_ORIGIN`（フロントのURL）からのリクエストだけ許可するCORSヘッダーを返している。

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
通知1回だけだと「無視してそのまま二度寝」ができてしまう。スクワットを完了して `/ack` を送るまで毎分通知を飛ばし続ける。アプリを完全に無視すれば30分でタイムアウトするので無限には続かない。

---

### `web/` — スマホで表示するPWA

#### `web/vite.config.ts` — ビルド設定

```typescript
VitePWA({
  strategies: 'injectManifest',  // カスタムSWを使う（後述）
  srcDir: 'src',
  filename: 'sw.ts',             // Service Workerのソース
  manifest: {
    display: 'standalone',       // ホーム画面追加したときにアドレスバーを隠す
    ...
  },
})
```

`@shared/*` の alias も設定してあり、`import ... from '@shared/types.js'` のように書ける。

---

#### `web/src/sw.ts` — Service Worker

**Service Workerとは？**  
ブラウザとネットワークの間に置かれる「中継プロキシ」みたいなもの。アプリが閉じていても動き続けられる。PWAの要であり、Push通知の受信もここで処理される。

```typescript
// push通知を受信 → 通知を表示
self.addEventListener('push', () => {
  self.registration.showNotification('earlyBird ⏰', {
    requireInteraction: true,    // ← これが重要。タップしないと消えない
    vibrate: [500, 200, 500, 200, 500],  // Android: バイブパターン
  });
});

// 通知タップ → アプリを前面に出す
self.addEventListener('notificationclick', (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clientList => {
      // 既にアプリが開いていればそのウィンドウをfocusしてメッセージを送る
      for (const client of clientList) {
        client.postMessage({ type: 'ALARM_TRIGGERED' });
        return client.focus();
      }
      // 開いていなければ /alarm を開く
      return self.clients.openWindow('/alarm');
    })
  );
});
```

`precacheAndRoute(self.__WB_MANIFEST)` はビルド時にViteが自動生成するファイルリストを元に、アプリのファイルをオフラインでもキャッシュから返せるようにする処理。

---

#### `web/src/App.tsx` — ルーティング

シンプルなハッシュベースのルーティング。`window.location.hash` が `#alarm` なら筋トレ画面、それ以外はホーム画面を表示。react-routerなどの外部ライブラリは使っていない。

SWから `ALARM_TRIGGERED` メッセージが来たら `#alarm` に遷移するよう `Home.tsx` で監視している。

---

#### `web/src/routes/Home.tsx` — アラーム設定画面

**通知許可フロー:**  
```
「通知を許可する」ボタンをタップ
  ↓
navigator.serviceWorker.ready  (SWの準備完了まで待機)
  ↓
Notification.requestPermission()  (ユーザーに許可ダイアログを表示)
  ↓
pushManager.subscribe({ applicationServerKey: VAPID公開鍵 })
  ↓
subscriptionオブジェクト取得 → POST /alarms でサーバーに保存
```

`applicationServerKey` にVAPID公開鍵を渡すことで、「このサーバー（earlyBirdのWorker）だけがこのデバイスに通知を送れる」という紐付けができる。

**アラームの保存先が2箇所ある理由:**  
- `localStorage`（端末内）: アプリを開いたときに素早く読み込むため
- Cloudflare KV（サーバー）: Cronがアラーム時刻を確認するため

2箇所を同期するのが `updateAlarms()` 関数で、ローカルに保存したあとサーバーにも `POST /alarms` を送っている。

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
  //     ← ユーザー操作のイベント内から呼ばないとiOSで音が出ない
  startAlarm();

  // (b) DeviceMotion（加速度センサー）の権限を取得
  //     ← iOS 13+はこれも必ずユーザー操作起点から呼ぶ必要がある
  const granted = await requestMotionPermission();

  // (c) Wake Lockで画面を消さない
  //     ← スクワット中に画面ロックされたら詰むので
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
  stopAlarm();          // 音を止める
  stopRepCounter();     // センサー監視を止める
  wakeLockRef.current?.release();  // 画面ロック制御を解放
  await sendAck(subscription, alarmId);  // サーバーに完了を通知
}
```

**円グラフの仕組み（SVG）:**  
SVGの `circle` に `stroke-dasharray`（一周の長さ）と `stroke-dashoffset`（どのくらいずらすか）を指定すると、円形のプログレスバーが作れる。

```
strokeDasharray  = 円周 = 2π × 半径52 ≒ 326.7
strokeDashoffset = 円周 × (1 - 進捗率)
→ 0回/10回のとき: offset = 326.7（全部ずらす = 何も表示されない）
→ 5回/10回のとき: offset = 163.3（半分表示）
→ 10回/10回のとき: offset = 0（全部表示）
```

---

#### `web/src/lib/repCounter.ts` — スクワット検出

**DeviceMotionEventとは？**  
スマホの加速度センサーのデータをJavaScriptで受け取れるAPIで、端末がどのくらい速く動いているかが `x, y, z` 軸で毎フレーム飛んでくる。

```typescript
motionHandler = (event: DeviceMotionEvent) => {
  const acc = event.accelerationIncludingGravity;
  // ← 重力を含む加速度（重力を除いた acc.acceleration もあるが安定性が低い）

  const ay = Math.abs(acc.y ?? 0);  // 上下方向の大きさ

  // しきい値(12 m/s²)を超えたら1回カウント
  // ただし前回のカウントから600ms以上経過していないと無視（連続検出防止）
  if (ay > threshold && now - lastRepTime > minInterval) {
    repCount++;
    onRep(repCount);
  }
};
```

しきい値 `12 m/s²` の根拠：重力加速度が約 9.8 m/s²、それより大きな値がスクワットの立ち上がり動作で発生する。ただしこの値は体型・スマホの持ち方・スクワットの速さで変わるので、将来的にはキャリブレーション機能が必要かもしれない。

**iOS権限の仕組み:**  
AndroidやPCは `DeviceMotionEvent` が最初から使える（許可不要）が、iOSは iOS 13 から `DeviceMotionEvent.requestPermission()` を呼ばないと使えなくなった。しかもこの関数はユーザー操作イベント（タップなど）の中から呼ばないとエラーになる。なので「タップして起きる」ボタンの中でまとめて許可を取っている。

---

#### `web/src/lib/audio.ts` — アラーム音生成

スマホにアラーム音のMP3を置くよりも、Web Audio APIで音を合成するほうが依存ファイルが不要で軽い。

```typescript
function generateAlarmBuffer(ctx: AudioContext): AudioBuffer {
  // 880Hz と 1320Hz の正弦波を合成（不協和音）
  // envelopeで最初と最後をフェードイン/アウト
  data[i] = envelope * (
    0.6 * Math.sin(2 * Math.PI * 880 * t) +
    0.4 * Math.sin(2 * Math.PI * 1320 * t)
  );
}
```

生成した0.8秒のバッファを `loop: true` でループ再生する。AudioContextはユーザー操作内から生成することでiOSの自動再生制限を回避している。

---

#### `web/src/lib/api.ts` — サーバーへのAPIリクエスト

フロントからWorkerへの通信を担当。特筆すべきは `registerPush()` でsubscriptionを取得するときの処理：

```typescript
// Uint8Array<ArrayBufferLike> はそのまま渡せないのでArrayBufferにコピー
const keyBytes = base64urlToUint8Array(VAPID_PUBLIC_KEY);
const keyBuffer = keyBytes.buffer.slice(...) as ArrayBuffer;
sub = await reg.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: keyBuffer,
});
```

TypeScriptの型エラー（`ArrayBufferLike` は `ArrayBuffer` に代入不可）を回避するため、`.slice()` で新しい `ArrayBuffer` としてコピーしている。

---

#### `web/src/lib/storage.ts` — ローカルストレージ

シンプルに `localStorage` にJSONでアラームを保存・読み込みするだけ。`generateId()` は `crypto.randomUUID()` でブラウザ標準のUUID生成。

---

#### `web/src/lib/constants.ts` — 定数

```typescript
export const WORKER_URL = import.meta.env.VITE_WORKER_URL ?? 'http://localhost:8787';
```

`VITE_WORKER_URL` 環境変数が設定されていなければローカル開発用の `localhost:8787`（Wranglerのデフォルトポート）を使う。本番デプロイ時は `.env.local` に本番WorkerのURLを書く。

---

## セキュリティについて

### なぜリポジトリがpublicでも安全なのか

- **VAPID秘密鍵** は `worker/.dev.vars` に保存。`.gitignore` で除外しているのでコミットされない。本番は `wrangler secret put` でCloudflareの暗号化ストレージに入れる
- **VAPID公開鍵** は `constants.ts` にハードコードされているが、これは公開前提の鍵なので問題ない（誰が見てもいい）
- **APIエンドポイントの保護** は Cloudflare Access（Zero Trust）で行う。Googleアカウントでログインしたユーザーだけがアクセスできる。フロントのJSに「パスワード」を埋め込む方法は、JSバンドルを展開すれば誰でも読めるのでNG

### CORS設定

```typescript
'Access-Control-Allow-Origin': env.FRONT_ORIGIN  // 自分のサイトのURLだけ許可
```

`FRONT_ORIGIN` 以外のサイトからAPIを叩いても弾かれる。

---

## 既知の制限と対処法

### iOSのマナースイッチ問題

物理的な横のスイッチ（マナーモードスイッチ）をONにしているとWeb Audioの音が鳴らない。ネイティブアプリのアラームはこれを無視できるが、PWAはできない。**使う前にマナースイッチをOFFにする運用が必要。**

### Push通知を完全に無視するとどうなるか

通知をタップしない場合、30分間（`ALARM_TIMEOUT_MINUTES`）は毎分通知が来続ける。30分後は自動でfiring状態が解除される。アラームとして機能しているとは言えないが、PWAの限界として受け入れている。

### iOSでPush通知を使う条件

- iOS 16.4以上
- Safariで一度サイトを開いた状態で「ホーム画面に追加」する
- 通常のSafariブラウザのタブでは通知が届かない（ホーム画面追加が必須）

### Push Payloadが暗号化されていない

現在は「空のPing」を送ってSWが固定メッセージを表示している。将来的にはサーバーからメッセージ内容を送れるようにしたいが、Web PushのPayload暗号化（aes128gcm）はWorkers上でも実装が必要で、今は未対応。

---

## 今後やること（後続フェーズ）

| 優先度 | 内容 | 難易度 |
|---|---|---|
| 高 | 実機テスト・スクワット検出のしきい値チューニング | 低 |
| 高 | デプロイ（KV作成・wrangler secret設定・Cloudflare Pages） | 中 |
| 中 | Cloudflare Access設定 | 低 |
| 中 | Push Payload暗号化（aes128gcm対応） | 高 |
| 低 | MediaPipe/TensorFlow.jsによるカメラスクワット認識 | 高 |
| 低 | 起床ログ・統計 | 中 |
| 低 | ジャンプ・シェイクなど他の運動種目 | 中 |
