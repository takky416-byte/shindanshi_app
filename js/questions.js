import { SUBJECTS } from "./data/subjects.js";
import { PASTEXAM_QUESTIONS } from "./data/pastexam/index.js";

export { SUBJECTS };

// 表・画像・SQL文などを含む設問は text の代わりに blocks（段落・表・画像・コードの配列）で
// 出題文を組み立てる。blocks しかない設問には、検証やフォールバック表示のために
// text（プレーンテキスト版）をここで自動生成しておく。
function deriveText(q) {
  if (q.text) return q.text;
  if (Array.isArray(q.blocks)) {
    return q.blocks
      .filter((b) => b.type === "p" || b.type === "code")
      .map((b) => b.text)
      .join("\n\n");
  }
  return "";
}

export const QUESTIONS = [...PASTEXAM_QUESTIONS].map((q) => ({
  ...q,
  text: deriveText(q)
}));
