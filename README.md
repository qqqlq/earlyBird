# earlyBird 🐦

筋トレしないと止まらない目覚ましPWA。

指定時刻にPush通知でアラームが鳴り、スマホを持ってスクワットをN回完了するまで止まらない。

## 技術スタック

| 領域 | 採用 |
|---|---|
| フロント | React + Vite + TypeScript (PWA) |
| バックエンド | Cloudflare Workers + KV |
| アラーム配信 | Web Push (VAPID) + Cloudflare Cron (毎分) |
| ホスティング | Cloudflare Pages + earlybird.nodewalker.app |
| アクセス保護 | Cloudflare Access (Zero Trust) |

## セットアップ

### 前提

- Cloudflareアカウント（無料）
- Node.js 18+
- Wrangler CLI (`npm install -g wrangler && wrangler login`)

### 1. KVネームスペースを作成

```bash
cd worker
npx wrangler kv:namespace create ALARMS_KV
npx wrangler kv:namespace create ALARMS_KV --preview
```

`wrangler.toml` の `REPLACE_WITH_KV_NAMESPACE_ID` を出力されたIDに置き換える。

### 2. VAPID秘密鍵を設定

```bash
# .dev.varsに書いた VAPID_PRIVATE_KEY_D と VAPID_SUBJECT をWorkerシークレットに登録
npx wrangler secret put VAPID_PRIVATE_KEY_D
npx wrangler secret put VAPID_SUBJECT
# VAPID_SUBJECTは "mailto:your@email.com" の形式
```

### 3. フロントのWorker URLを設定

```bash
cd web
cp .env.example .env.local
# VITE_WORKER_URL にWorkerのURLを設定（例: https://earlybird-worker.example.workers.dev）
```

### 4. 開発サーバーを起動

```bash
# terminal 1: Worker
cd worker && npx wrangler dev

# terminal 2: PWA
cd web && npm run dev
```

### 5. 本番デプロイ

```bash
# Worker
cd worker && npx wrangler deploy

# PWA
cd web && npm run build && npx wrangler pages deploy dist --project-name earlybird
```

### 6. Cloudflare Dashboardで設定

1. `earlybird.nodewalker.app` のDNS CNAMEレコードをCloudflare Pagesに向ける
2. Cloudflare Access → Zero Trust → Applications で `earlybird.nodewalker.app` を追加し、自分のGoogleアカウントのみ許可

> **iOS利用時の注意**: ホーム画面に追加（Safari → 共有 → ホーム画面に追加）しないとPush通知が届きません（iOS 16.4+必須）。また、物理マナースイッチがONだとアラーム音が鳴りません。

## リポジトリ構成

```
earlyBird/
  web/       … Vite React PWA
  worker/    … Cloudflare Worker（API + Cron）
  shared/    … alarmMatch・型定義（共通）
  docs/      … 設計ドキュメント
```

## チェンジログ

### v0.1.0 (2026-05-30)
- 初回実装
- アラーム設定UI（時刻・曜日・スクワット回数）
- Web Push通知（Cloudflare WorkerのCronで毎分判定、/ackまで再送）
- DeviceMotionによるスクワット実検出
- Wake Lock・Web Audio大音量ループ
- Cloudflare Access統合
