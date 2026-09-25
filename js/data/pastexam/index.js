// 過去問データの集約ポイント。
// 1ファイル = 1年度×1科目 を目安に js/data/pastexam/<subject>-<year>.js を追加し、
// ここで import して PASTEXAM_QUESTIONS に連結する。
// スキーマや作成手順は docs/pastexam-ingestion.md を参照。
import { IT_2026_QUESTIONS } from "./it-2026.js";
import { FIN_2026_QUESTIONS } from "./fin-2026.js";
import { OPS_2026_QUESTIONS } from "./ops-2026.js";
import { MGT_2026_QUESTIONS } from "./mgt-2026.js";
import { ECON_2026_QUESTIONS } from "./econ-2026.js";
import { LAW_2026_QUESTIONS } from "./law-2026.js";
import { SME_2019_QUESTIONS } from "./sme-2019.js";
import { SME_2020_QUESTIONS } from "./sme-2020.js";

export const PASTEXAM_QUESTIONS = [
  ...IT_2026_QUESTIONS,
  ...FIN_2026_QUESTIONS,
  ...OPS_2026_QUESTIONS,
  ...MGT_2026_QUESTIONS,
  ...ECON_2026_QUESTIONS,
  ...LAW_2026_QUESTIONS,
  ...SME_2019_QUESTIONS,
  ...SME_2020_QUESTIONS
];
