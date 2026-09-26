# 診断士ジム

夫婦で中小企業診断士1次試験対策をするための、スマホの隙間時間で使う演習PWA。
背景・経緯は Claude Artifact 上で試作した際の引き継ぎブリーフィングを参照（開発チャット内で共有済み）。

## 現在のアーキテクチャ（v1）

- **ビルドレス・vanilla JS の静的PWA**。フレームワーク／バンドラなし。`index.html` を任意の静的ホスティング（GitHub Pages、Cloudflare Pages 等）にそのまま置けば動く。
- `js/questions.js` … `js/data/pastexam/index.js`（過去問、2019〜2026年度×7科目）を統合するエントリーポイント。各設問に `source: "pastexam"` タグを持たせてある。過去問の取り込み手順は [`docs/pastexam-ingestion.md`](./docs/pastexam-ingestion.md) を参照。
- `scripts/validate-questions.mjs` … 問題データの整合性チェック（`node scripts/validate-questions.mjs`）。過去問追加時は必ず実行する。
- `js/app.js` … アプリ本体。ユーザー切り替え、クイズ進行、夫婦比較ダッシュボード、同期コード、Service Worker登録、インストール導線を担当。
- `manifest.webmanifest` / `sw.js` / `icons/` … PWA化（ホーム画面追加・オフライン利用）。`sw.js` はアプリシェルをキャッシュファーストで配信する。
- 進捗データは **localStorage のみ**（バックエンド・アカウントなし）。夫婦間の同期は「同期コード」（進捗をBase64エンコードした文字列）をコピー&ペーストして手動マージする方式。設問ID＋タイムスタンプで重複排除してマージする（`mergeAnswered`）。

### プロトタイプ（Claude Artifact版）からの変更点

- 単一HTMLファイルから `index.html` / `css/style.css` / `js/*.js` に分割。
- Claude Artifact の `db` capability への依存を削除（サインイン不要の同期コード方式に一本化。db機能はサインイン必須のため夫婦間同期には使えなかった）。
- PWA化（`manifest.webmanifest`、`sw.js`、アイコン一式）を追加。
- 問題データに `source` タグを追加し、将来の過去問データ投入に備えた。

## ローカルでの動作確認

ビルド不要。任意の静的サーバーで配信するだけ（`file://` では Service Worker と ES Module が動かないため必ずHTTPサーバー経由にすること）。

```bash
python3 -m http.server 8080
# → http://localhost:8080 を開く
```

## 今後のロードマップ（引き継ぎブリーフィングのTODOより）

- [x] PWA化（manifest.json, service worker, アイコン一式）
- [ ] 過去問PDFのアップロード→構造化データ抽出パイプライン（着手中）
  - データ構造・検証スクリプト・受け入れ手順は整備済み（[`docs/pastexam-ingestion.md`](./docs/pastexam-ingestion.md)）。PDF自体のアップロード待ち。
  - 優先度高：経営情報システム、財務・会計、運営管理
  - 優先度中：企業経営理論、経済学・経済政策
  - 優先度低（最新年度のみ）：中小企業経営・政策
- [ ] 白書公表（毎年4月下旬）に合わせたコンテンツ更新フロー
  - 「経営」パート（統計の型）は年をまたいで安定 → 過去問で先行学習可能
  - 「政策」パート（制度・数値）は白書公表後（4月以降）でないと最新情報を仕込めない
- [ ] アカウント機構の検討（サインイン不要を維持するか、簡易アカウントを導入してWeb Push/メール通知を実現するか）
  - これを導入する場合、常時稼働するバックエンド（Node.js等）とDBが前提になる
- [ ] Web Push通知の実装（Web Push API + Service Worker + VAPIDキー）
- [ ] メール通知の実装（SendGrid/Resend等）
- [ ] 参考動画リンク（TBC受験研究会等）の解説欄への統合（リンク紹介のみ、転載不可）

### 既知の技術的制約

1. 中小企業診断協会サイトへの直接スクレイピングはこの開発環境からはブロックされる。過去問はユーザー側でPDFをダウンロード→アップロードする運用を想定。
2. アカウント制なしでの夫婦間リアルタイム同期は仕組み上できない（同期コードの手動共有で代替）。プッシュ/メール通知を実装する際は、アカウント機構とバックエンドの導入が前提になる。
