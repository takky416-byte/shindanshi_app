// 過去問データの集約ポイント。
// 1ファイル = 1年度×1科目 を目安に js/data/pastexam/<subject>-<year>.js を追加し、
// ここで import して PASTEXAM_QUESTIONS に連結する。
// スキーマや作成手順は docs/pastexam-ingestion.md を参照。
import { IT_2026_QUESTIONS } from "./it-2026.js";
import { FIN_2026_QUESTIONS } from "./fin-2026.js";
import { OPS_2026_QUESTIONS } from "./ops-2026.js";

export const PASTEXAM_QUESTIONS = [
  ...IT_2026_QUESTIONS,
  ...FIN_2026_QUESTIONS,
  ...OPS_2026_QUESTIONS
];
