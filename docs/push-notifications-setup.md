# プッシュ通知：デプロイ手順（要・手動作業）

プッシュ通知（マイルストーン通知・相手のペース通知）のコードは実装済みだが、
以下はこの開発環境からは実行できない（Firebaseへのログイン・課金設定は
利用者自身のアカウントでのみ可能なため）。**両方の手順を一度だけ**行えば、
以降は普段通り `git push` するだけで Cloud Functions 側のロジック変更も
反映されるようになる（Cloud Functionsのコードだけは `firebase deploy` が
別途必要点に注意。GitHub Pages側の静的ファイルは今まで通り自動反映）。

## 1. VAPID公開鍵を取得してコードに設定する

1. [Firebaseコンソール](https://console.firebase.google.com/) → 対象プロジェクト（`shindanshi-app-b7fba`）を開く。
2. 「プロジェクトの設定」→「Cloud Messaging」タブ →「ウェブ構成」→「ウェブプッシュ証明書」。
3. 鍵ペアがまだなければ「鍵ペアを生成」をクリック。表示された文字列（`B...` で始まる長い文字列）をコピーする。
4. `js/cloud-sync.js` 内の下記の行を書き換えて保存・コミットする：
   ```js
   const VAPID_PUBLIC_KEY = "REPLACE_WITH_FIREBASE_CONSOLE_VAPID_KEY";
   ```
   → コピーした値に置き換える（クォートはそのまま）。

## 2. Cloud Functions をデプロイする

ローカルPC（この開発環境ではなく、手元のPC）で以下を実行する。

```bash
npm install -g firebase-tools   # 未インストールの場合のみ
firebase login                  # ブラウザでFirebaseアカウントにログイン
cd shindanshi_app
firebase deploy --only functions
```

- `firebase.json` / `.firebaserc` はリポジトリに含めてあるので、`firebase use` の設定は不要。
- 初回デプロイ時、`functions/` の依存パッケージ（`firebase-admin` / `firebase-functions`）が自動インストールされる。手元で先に試したい場合は `cd functions && npm install` でも可。
- デプロイが成功すると、`onRoomWriteMilestone`（Firestore書き込みトリガー）と `dailyPaceNotification`（毎日21:00 JST実行）の2つの関数がFirebase側に登録される。

## 3. 両端末で通知を有効化する

1. スマホでアプリを開き、設定パネルを開く。
2. 「クラウド同期」でペアコードに接続済みであることを確認（プッシュ通知はクラウド同期が前提）。
3. 「プッシュ通知」ブロックの「通知を有効にする」をタップ → ブラウザの通知許可ダイアログで「許可」を選ぶ。
4. 夫・妻それぞれの端末で同じ手順を行う（**アクティブユーザーを正しく選んでから**有効化すること。押した時点の「夫/妻」切り替えボタンの選択状態で、どちらの端末として登録するかが決まる）。

## 4. 動作確認のしかた

- **マイルストーン通知**：どちらかが解答を進めて累計が100の倍数を超えると、もう片方に届く。すぐ試したい場合は、`shindanshi_progress_*` の件数を100問超えるところまで実際に解答するか、Firestoreコンソールで該当ルームの `husband.answered` / `wife.answered` 配列の長さを手動で調整して書き込みを発生させても良い。
- **相手のペース通知**：毎日21:00（JST）に自動実行される。すぐ試したい場合は、Firebaseコンソール →「Cloud Scheduler」または「Cloud Functions」の該当ジョブ（`dailyPaceNotification`）から手動で「今すぐ実行」できる。
- 通知が届かない場合は、まずFirebaseコンソールの「Functions」→ 各関数のログでエラーが出ていないか確認する（無効なトークン、VAPID鍵未設定などはログに出る）。

## 5. 既知の制約

- Android Chrome での利用を前提に実装している（iOSでの動作確認は行っていない）。
- 通知はテキストのみ（title/body）。アイコン・遷移先URLは端末側（`sw.js`）でデプロイ先パスから組み立てる。
