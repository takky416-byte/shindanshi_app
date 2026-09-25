// 過去問データの集約ポイント。
// 1ファイル = 1年度×1科目 を目安に js/data/pastexam/<subject>-<year>.js を追加し、
// ここで import して PASTEXAM_QUESTIONS に連結する。
// スキーマや作成手順は docs/pastexam-ingestion.md を参照。
import { IT_2026_QUESTIONS } from "./it-2026.js";
import { FIN_2026_QUESTIONS } from "./fin-2026.js";
import { FIN_2019_QUESTIONS } from "./fin-2019.js";
import { FIN_2020_QUESTIONS } from "./fin-2020.js";
import { FIN_2021_QUESTIONS } from "./fin-2021.js";
import { FIN_2022_QUESTIONS } from "./fin-2022.js";
import { FIN_2023_QUESTIONS } from "./fin-2023.js";
import { FIN_2024_QUESTIONS } from "./fin-2024.js";
import { FIN_2025_QUESTIONS } from "./fin-2025.js";
import { OPS_2019_QUESTIONS } from "./ops-2019.js";
import { OPS_2020_QUESTIONS } from "./ops-2020.js";
import { OPS_2021_QUESTIONS } from "./ops-2021.js";
import { OPS_2022_QUESTIONS } from "./ops-2022.js";
import { OPS_2023_QUESTIONS } from "./ops-2023.js";
import { OPS_2024_QUESTIONS } from "./ops-2024.js";
import { OPS_2026_QUESTIONS } from "./ops-2026.js";
import { MGT_2026_QUESTIONS } from "./mgt-2026.js";
import { MGT_2019_QUESTIONS } from "./mgt-2019.js";
import { MGT_2020_QUESTIONS } from "./mgt-2020.js";
import { MGT_2021_QUESTIONS } from "./mgt-2021.js";
import { MGT_2022_QUESTIONS } from "./mgt-2022.js";
import { MGT_2023_QUESTIONS } from "./mgt-2023.js";
import { MGT_2024_QUESTIONS } from "./mgt-2024.js";
import { MGT_2025_QUESTIONS } from "./mgt-2025.js";
import { ECON_2026_QUESTIONS } from "./econ-2026.js";
import { ECON_2019_QUESTIONS } from "./econ-2019.js";
import { ECON_2020_QUESTIONS } from "./econ-2020.js";
import { ECON_2021_QUESTIONS } from "./econ-2021.js";
import { ECON_2022_QUESTIONS } from "./econ-2022.js";
import { ECON_2023_QUESTIONS } from "./econ-2023.js";
import { ECON_2024_QUESTIONS } from "./econ-2024.js";
import { ECON_2025_QUESTIONS } from "./econ-2025.js";
import { LAW_2026_QUESTIONS } from "./law-2026.js";
import { SME_2019_QUESTIONS } from "./sme-2019.js";
import { SME_2020_QUESTIONS } from "./sme-2020.js";
import { SME_2021_QUESTIONS } from "./sme-2021.js";
import { SME_2022_QUESTIONS } from "./sme-2022.js";
import { SME_2023_QUESTIONS } from "./sme-2023.js";
import { SME_2024_QUESTIONS } from "./sme-2024.js";
import { SME_2025_QUESTIONS } from "./sme-2025.js";
import { SME_2026_QUESTIONS } from "./sme-2026.js";

export const PASTEXAM_QUESTIONS = [
  ...IT_2026_QUESTIONS,
  ...FIN_2026_QUESTIONS,
  ...FIN_2019_QUESTIONS,
  ...FIN_2020_QUESTIONS,
  ...FIN_2021_QUESTIONS,
  ...FIN_2022_QUESTIONS,
  ...FIN_2023_QUESTIONS,
  ...FIN_2024_QUESTIONS,
  ...FIN_2025_QUESTIONS,
  ...OPS_2019_QUESTIONS,
  ...OPS_2020_QUESTIONS,
  ...OPS_2021_QUESTIONS,
  ...OPS_2022_QUESTIONS,
  ...OPS_2023_QUESTIONS,
  ...OPS_2024_QUESTIONS,
  ...OPS_2026_QUESTIONS,
  ...MGT_2026_QUESTIONS,
  ...MGT_2019_QUESTIONS,
  ...MGT_2020_QUESTIONS,
  ...MGT_2021_QUESTIONS,
  ...MGT_2022_QUESTIONS,
  ...MGT_2023_QUESTIONS,
  ...MGT_2024_QUESTIONS,
  ...MGT_2025_QUESTIONS,
  ...ECON_2026_QUESTIONS,
  ...ECON_2019_QUESTIONS,
  ...ECON_2020_QUESTIONS,
  ...ECON_2021_QUESTIONS,
  ...ECON_2022_QUESTIONS,
  ...ECON_2023_QUESTIONS,
  ...ECON_2024_QUESTIONS,
  ...ECON_2025_QUESTIONS,
  ...LAW_2026_QUESTIONS,
  ...SME_2019_QUESTIONS,
  ...SME_2020_QUESTIONS,
  ...SME_2021_QUESTIONS,
  ...SME_2022_QUESTIONS,
  ...SME_2023_QUESTIONS,
  ...SME_2024_QUESTIONS,
  ...SME_2025_QUESTIONS,
  ...SME_2026_QUESTIONS
];
