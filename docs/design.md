# earlyBird 設計ドキュメント

## 何をしたか

二度寝を防ぐため、「指定時刻にアラームが鳴り、加速度センサーで実検出したスクワットN回を完了しないと止まらない」PWAアラームアプリを実装した。

### 実装した機能
- アラーム設定UI（時刻・曜日・スクワット回数）
- Web Push通知（バックエンドから指定時刻に送信）
- Service Worker（push受信→通知表示、タップで/alarmへ遷移）
- アラーム画面（Web Audio大音量ループ・DeviceMotionスクワット検出・Wake Lock）
- Cloudflare Worker API（POST /alarms, POST /ack, POST /test-push）
- 毎分Cron（firing再送・タイムアウト30分）
- shared/alarmMatch.ts（純粋関数、tzを考慮したアラーム判定）

## なぜそうしたか

| 設計選択 | 理由 |
|---|---|
| PWA | App Store$99/年を回避、iOS/Android両対応 |
| Web Push + バックエンド | アプリを閉じても鳴らすには必須。ブラウザAPIだけでは信頼できる時刻起動不可 |
| 加速度センサー（DeviceMotion） | タイピング・回数ボタンは布団内で完結し目覚まし効果なし。物理的な上下運動を検出する方式が最も確実 |
| Cloudflare Workers + KV | 無料枠で毎分Cron可。Vercel HobbyのCronは1日1回のため不適 |
| Cloudflare Access | publicリポジトリ前提でAPIを保護。フロントJSにトークンを埋め込む方式は誰でも読める |
| firing再送 | Push通知1回だけだと無視されたら二度寝成立。/ackまで毎分再送で「鳴り続ける」挙動を実現 |
| Wake Lock | 筋トレ中の画面自動ロック防止 |

## アーキテクチャ

```
[スマホ] ←── Push通知 ──── [Cloudflare Worker]
   │                             │
   │ PWA(Cloudflare Pages)        │ KV (alarms + firing)
   │ earlybird.nodewalker.app     │
   │                             │ Cron(毎分)
   ↓ POST /alarms, POST /ack     ↓
[earlybird-worker.nodewalker.app]
```

## 既知の問題・TODO

### 重要な制約（受容済み）
1. **iOSの物理ミュートスイッチ**: マナースイッチONだとWeb Audioが無音になる（ネイティブアラームは無視できるがPWAは不可）。**起床時はマナースイッチを切る運用が必要。**
2. **通知を完全に無視される場合**: Push通知をタップしない限りAckは送られないが、毎分再送は継続する。30分でタイムアウト。
3. **iOSのWeb Push**: iOS 16.4+かつホーム画面追加済みPWAでのみ対応。通常のSafariブラウザでは動作しない。
4. **Push Payload暗号化**: 現在は空push（ペイロードなし）を送りSW側で固定メッセージを表示している。将来的にはaes128gcm暗号化で動的メッセージ送信に対応予定。

### 後続フェーズ（スコープ外）
- MediaPipe / TensorFlow.js によるカメラスクワット認識
- Speak等の外部アプリのディープリンク起動＋タイマー補助
- スヌーズ統計・起床ログ
- 筋トレ以外の運動種目（ジャンプ・シェイク等）の追加とキャリブレーション

## デプロイ手順（概要）

詳細はREADME.mdを参照。

1. `wrangler kv:namespace create ALARMS_KV` でKVを作成し、IDを`wrangler.toml`に設定
2. `wrangler secret put VAPID_PRIVATE_KEY_D` でVAPID秘密鍵を設定
3. `wrangler secret put VAPID_SUBJECT` でメールアドレスを設定
4. `wrangler deploy` でWorkerをデプロイ
5. `cd web && npm run build && npx wrangler pages deploy dist` でPWAをデプロイ
6. Cloudflare DashboardでカスタムドメインとAccessポリシーを設定
