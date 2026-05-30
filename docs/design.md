# earlyBird 設計ドキュメント

## 何をしたか

二度寝を防ぐため、「指定時刻にアラームが鳴り、加速度センサーで実検出したスクワットN回を完了しないと止まらない」PWAアラームアプリを実装・デプロイした。

### 動作確認済みの機能（2026-05-31）
- iPhoneのロック画面にPush通知が届く（毎分再送）
- 通知をタップするとアプリが開き「タップして起きる」画面になる
- ボタンをタップするとアラーム音（Web Audio合成）が鳴り始める
- スマホを持ってスクワットすると加速度センサーで回数を検出してカウント
- 目標回数達成でアラーム停止・「おはよう！」画面に遷移
- PC・iPhoneどちらでもUIが正常表示される

### デプロイ済み環境
| 種別 | URL |
|---|---|
| フロント（PWA） | https://earlybird.nodewalker.app |
| バックエンド（Worker） | https://earlybird-worker.nodewalker.workers.dev |
| Cloudflare Pages | earlybird（プロジェクト名） |
| Cron | 毎分実行中 |

---

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

---

## アーキテクチャ

```
[iPhone]
  ↓ ホーム画面追加PWA (earlybird.nodewalker.app)
  ↓ 通知許可 → subscriptionをWorkerに送信
  
[Cloudflare Worker] (earlybird-worker.nodewalker.workers.dev)
  ├─ Cron (毎分)
  │   └─ matchAlarms() でアラーム判定
  │       → 該当あり: KVにfiring状態セット → Push送信
  │       → firing中: タイムアウト確認 → Push再送
  ├─ POST /alarms  ← フロントからsubscription+アラーム設定を受け取る
  ├─ POST /ack     ← スクワット完了を受け取りfiring解除
  └─ POST /test-push ← 開発用即時Push

[Cloudflare KV]
  └─ { subscription, tz, alarms[], firing } を1デバイス1エントリで保存
```

---

## iOSで発生した問題と対処

### 1. 画面が真っ暗（背景色のみ表示）
**原因**: `Notification` APIがiOS SafariのSWAなし状態（通常タブ）では `undefined`。`Notification.permission` を参照した瞬間にエラーでReactがクラッシュ。

**対処**: `typeof Notification === 'undefined'` でガードし、未定義の場合は「ホーム画面に追加してください」の案内バナーを表示するように変更。

### 2. タイトルがDynamic Island/ノッチにかかる
**原因**: safe-area-insetの未設定。

**対処**: `.home` の `padding-top` を `max(24px, env(safe-area-inset-top))` に変更。

### 3. 起床時刻inputがはみ出る
**原因**: iOS SafariでのHTMLネイティブ `type="time"` レンダリングの挙動差異。

**対処**: `-webkit-appearance: none` と `box-sizing: border-box` を追加。

### 4. アラーム音が鳴らない（ユーザー操作前）
**原因**: iOSはユーザー操作起点でないとWeb Audioの再生が不可（ブラウザセキュリティ制限）。

**対処**: 設計上の決定として「タップして起きる」ボタンの中でaudio.start()を呼ぶ仕組みにしてある（仕様通り）。

---

## 既知の制限（受容済み）

### iOSの物理マナースイッチ
**状況**: マナースイッチONだとWeb Audioが無音になる。ネイティブアラームはこれを無視できるがPWAは不可。  
**運用**: **起床時はマナースイッチをOFFにして寝る運用が必要。**

### Push通知音のカスタマイズ不可（iOS）
**状況**: iOSのWeb Push通知音はシステム設定固定で、コードから変更できない。  
**対処**: iPhoneの設定 → 通知 → earlyBird → サウンド で大きめの音を選ぶことはできる。  
**将来**: Capacitorでネイティブアプリ化、またはAndroid端末を別途用意すれば解決（Androidはカスタム音・マナースイッチ無視が可能）。

### 通知を完全無視した場合
**状況**: Push通知をタップしない場合、30分間は毎分通知が来続ける。30分でタイムアウト。  

### iOSのWeb Push動作条件
**状況**: iOS 16.4以上 + Safariで「ホーム画面に追加」（Webアプリとして開くON）が必須。通常のSafariタブでは動作しない。

### Push Payloadが暗号化されていない
**状況**: 現在は空のPingを送りSW側で固定メッセージを表示。将来的にはaes128gcm暗号化で動的メッセージ送信に対応予定。

---

## 後続フェーズ（スコープ外）

| 優先度 | 内容 | 難易度 |
|---|---|---|
| 中 | スクワット検出しきい値のキャリブレーション機能 | 中 |
| 中 | Cloudflare Access設定（APIの認証保護） | 低 |
| 中 | Push Payload暗号化（aes128gcm対応） | 高 |
| 低 | MediaPipe / TensorFlow.jsによるカメラスクワット認識 | 高 |
| 低 | Capacitor + Android でネイティブアプリ化 | 高 |
| 低 | Speak等の外部アプリのディープリンク起動＋タイマー補助 | 中 |
| 低 | 起床ログ・統計 | 中 |
| 低 | ジャンプ・シェイクなど他の運動種目 | 中 |
