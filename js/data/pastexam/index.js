// 過去問データの集約ポイント。
// 1ファイル = 1年度×1科目 を目安に js/data/pastexam/<subject>-<year>.js を追加し、
// ここで import して PASTEXAM_QUESTIONS に連結する。
// スキーマや作成手順は docs/pastexam-ingestion.md を参照。

export const PASTEXAM_QUESTIONS = [];
