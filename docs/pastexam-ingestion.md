# 過去問データの取り込み手順

## 背景・制約

- 中小企業診断協会サイト（jf-cmca.jp）への直接アクセスは、ClaudeCodeのこの実行環境からはネットワークポリシーでブロックされている（403）。そのため、過去問PDFは**ユーザー側の端末でダウンロードし、このセッションにアップロードする**運用とする。
- 過去問PDFには通常「問題」と「正答（解答）」が別ファイルで公開されている。解説は付属しないため、explanation は毎回自作する必要がある。
- 過去問の著作権は協会に帰属する。本アプリは夫婦の家庭内学習用途のみで、公開・配布は行わない前提で運用する（公開する場合は利用規約を要再確認）。

## 優先度（引き継ぎブリーフィングより）

1. 優先度高：経営情報システム、財務・会計、運営管理（過去問の再利用価値が高い）
2. 優先度中：企業経営理論、経済学・経済政策
3. 優先度低（最新年度のみ）：中小企業経営・政策（白書データは年度ごとに陳腐化するため）

## 手順

1. **入手**: ユーザーが協会サイトから対象年度・科目の「問題」PDFと「正答」PDF（またはページ）をダウンロードし、このセッションにアップロードする。`scripts/fetch_pastexam_pdfs.py` を使うと、指定したページ上のPDFリンクを自動で一覧化・一括ダウンロードできる（下記「PDF収集の自動化」参照）。
2. **抽出**: PDFスキル（またはテキスト抽出）で問題PDFからテキストを取得する。スキャン画像PDFの場合はOCRが必要になる。
3. **構造化**: 抽出したテキストと正答を突き合わせながら、`js/data/pastexam/<subject>-<year>.js` を新規作成する。ファイル形式は下記スキーマ参照。1ファイル = 1年度×1科目を目安にする。
4. **解説を書く**: 過去問には解説が付属しないため、各設問に対して正誤の根拠となる解説（`explanation`）を新規に書く（一般知識としての解説であり、協会や予備校の解説文を転記しない）。
5. **登録**: `js/data/pastexam/index.js` で新規ファイルを import し、`PASTEXAM_QUESTIONS` 配列に連結する。
6. **検証**: `node scripts/validate-questions.mjs` を実行し、エラーが出ないことを確認する。
7. **動作確認**: ローカルサーバーで起動し、対象科目のチップで絞り込んで表示・解答できることを確認する。

## データスキーマ（過去問用）

```js
// js/data/pastexam/it-2024.js
export const IT_2024_QUESTIONS = [
  {
    id: "it-r6-01",              // 一意なID。慣例: <subject>-<年度略称>-<設問番号>
    subject: "it",               // js/data/subjects.js の key と一致させる
    subjectName: "経営情報システム",
    source: "pastexam",
    year: 2024,                  // 出題年度（西暦、数値）
    questionNumber: 1,           // 本試験での設問番号（正答表との突合用）
    text: "……設問文……",
    choices: ["……", "……", "……", "……"], // 2〜5件
    answer: 0,                   // choices のインデックス（0始まり）
    explanation: "……なぜその選択肢が正解か、自作の解説……"
  },
  // ...
];
```

表やSQL文などを含む設問は、`text` の代わりに `blocks`（段落・表・コードの配列）を使う。表は実際の `<table>` として描画され、`text` は blocks から自動生成されるので書かなくてよい（検証スクリプトのフォールバック用に内部で自動生成される）。

```js
{
  id: "it-r8-08",
  subject: "it",
  subjectName: "経営情報システム",
  source: "pastexam",
  year: 2026,
  questionNumber: 8,
  blocks: [
    { type: "p", text: "……導入の段落……" },
    { type: "table", caption: "任意のキャプション", headers: ["列1", "列2"], rows: [["値1", "値2"]] },
    { type: "code", text: "SELECT * FROM foo;" },     // SQL文などの等幅表示ブロック
    { type: "p", text: "……表の後に続く段落……" }
  ],
  choices: ["……", "……", "……", "……"],
  answer: 0,
  explanation: "……"
}
```

グラフ・図表読み取りが前提の設問（経済学の需給曲線グラフ、国別推移グラフなど）は `text` 化できないため、`image` ブロックでPDFページから切り出した画像を埋め込む。画像ファイルはリポジトリの `img/pastexam/<subject>-<year>/` 以下に保存し、`src` はリポジトリルートからの相対パス（例: `./img/pastexam/eco-2026/q1.png`）で指定する。`alt` は画面読み上げ用の代替テキストとして必須。

```js
{
  type: "image",
  src: "./img/pastexam/eco-2026/q1.png",
  alt: "日本・アメリカ・ドイツの財政収支（対GDP比）の推移グラフ",
  caption: "任意：出所などの注記"  // 省略可
}
```

`js/data/pastexam/index.js` 側で以下のように連結する：

```js
import { IT_2024_QUESTIONS } from "./it-2024.js";

export const PASTEXAM_QUESTIONS = [
  ...IT_2024_QUESTIONS,
];
```

## PDF収集の自動化（`scripts/fetch_pastexam_pdfs.py`）

ClaudeCodeのクラウド実行環境からは協会サイトへ直接アクセスできないため、このスクリプトは
**ユーザー自身のPC** で実行する（このリポジトリのセッション内では実行できない）。標準ライブラリ
のみで動作し、pipでの追加インストールは不要。特定のURLパターンを決め打ちせず、指定したページ
にある `.pdf` リンクをすべて検出して一覧化・ダウンロードする汎用スクリプトなので、サイトの
ページ構造が事前にわからなくても使える。

```bash
# まずは対象ページに直接あるPDFリンクだけを取得
python3 scripts/fetch_pastexam_pdfs.py https://www.jf-cmca.jp/contents/010_c_/shikenmondai.html

# 「令和」を含むリンク（年度別ページなど）をさらに1階層辿ってPDFを探す
python3 scripts/fetch_pastexam_pdfs.py <URL> --follow 令和 --depth 2

# 保存先フォルダを指定（既定は ./pastexam_pdfs）
python3 scripts/fetch_pastexam_pdfs.py <URL> --out ./pastexam_pdfs
```

同一ドメイン配下のリンクしか辿らず、リクエスト間に既定0.5秒の間隔を空ける。ダウンロードした
PDFをこのセッションにアップロードすれば、以降は通常の取り込み手順（抽出→構造化→解説執筆→
検証）に進める。

## チェックリスト

- [ ] `id` が全設問でユニーク
- [ ] `subject` が `js/data/subjects.js` の key と一致
- [ ] `answer` が `choices` の範囲内
- [ ] `year` / `questionNumber` を設定済み
- [ ] `explanation` を自作済み（転記していない）
- [ ] `node scripts/validate-questions.mjs` がエラーなしで通る
