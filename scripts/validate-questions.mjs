#!/usr/bin/env node
// 問題データの整合性チェック。過去問を追加するたびに実行すること。
// 使い方: node scripts/validate-questions.mjs
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SUBJECTS } from "../js/data/subjects.js";
import { QUESTIONS } from "../js/questions.js";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const subjectKeys = new Set(SUBJECTS.filter((s) => s.key !== "all").map((s) => s.key));
const errors = [];
const seenIds = new Set();

QUESTIONS.forEach((q, idx) => {
  const where = `#${idx} (id: ${q.id ?? "?"})`;

  if (!q.id || typeof q.id !== "string") errors.push(`${where}: id が不正`);
  else if (seenIds.has(q.id)) errors.push(`${where}: id "${q.id}" が重複`);
  else seenIds.add(q.id);

  if (!subjectKeys.has(q.subject)) errors.push(`${where}: subject "${q.subject}" が SUBJECTS に存在しない`);
  if (!q.subjectName || typeof q.subjectName !== "string") errors.push(`${where}: subjectName が不正`);

  if (q.source !== "original" && q.source !== "pastexam") {
    errors.push(`${where}: source は "original" か "pastexam" のいずれか（現在: ${q.source}）`);
  }
  if (q.source === "pastexam") {
    if (!q.year || typeof q.year !== "number") errors.push(`${where}: pastexam には year（数値、例: 2024）が必要`);
    if (!q.questionNumber) errors.push(`${where}: pastexam には questionNumber（本試験の設問番号）が必要`);
  }

  if (!q.text || typeof q.text !== "string" || q.text.length < 5) errors.push(`${where}: text が不正または短すぎる`);

  if (q.blocks !== undefined) {
    if (!Array.isArray(q.blocks) || q.blocks.length === 0) {
      errors.push(`${where}: blocks は空でない配列である必要がある`);
    } else {
      q.blocks.forEach((b, bi) => {
        const bwhere = `${where} blocks[${bi}]`;
        if (b.type === "table") {
          if (!Array.isArray(b.headers) || !Array.isArray(b.rows)) {
            errors.push(`${bwhere}: table は headers と rows の配列が必要`);
          } else {
            b.rows.forEach((row, ri) => {
              if (!Array.isArray(row) || row.length !== b.headers.length) {
                errors.push(`${bwhere} rows[${ri}]: 列数が headers（${b.headers.length}）と一致しない（現在: ${Array.isArray(row) ? row.length : typeof row}）`);
              }
            });
          }
        } else if (b.type === "p" || b.type === "code") {
          if (!b.text || typeof b.text !== "string") errors.push(`${bwhere}: ${b.type} には text（文字列）が必要`);
        } else if (b.type === "image") {
          if (!b.src || typeof b.src !== "string") {
            errors.push(`${bwhere}: image には src（文字列）が必要`);
          } else {
            const localPath = path.join(repoRoot, b.src.replace(/^\.\//, ""));
            if (!existsSync(localPath)) errors.push(`${bwhere}: image src のファイルが存在しない（${b.src}）`);
          }
          if (!b.alt || typeof b.alt !== "string") errors.push(`${bwhere}: image には alt（代替テキスト）が必要`);
        } else {
          errors.push(`${bwhere}: type は "p" / "table" / "code" / "image" のいずれか（現在: ${b.type}）`);
        }
      });
    }
  }

  if (!Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 5) {
    errors.push(`${where}: choices は2〜5件の配列である必要がある（現在: ${Array.isArray(q.choices) ? q.choices.length : typeof q.choices}）`);
  } else if (q.choices.some((c) => typeof c !== "string" || c.length === 0)) {
    errors.push(`${where}: choices に空文字または非文字列が含まれる`);
  }

  if (typeof q.answer !== "number" || !Array.isArray(q.choices) || q.answer < 0 || q.answer >= q.choices.length) {
    errors.push(`${where}: answer が choices の範囲外（answer: ${q.answer}）`);
  }

  if (!q.explanation || typeof q.explanation !== "string" || q.explanation.length < 5) {
    errors.push(`${where}: explanation が不正または短すぎる（過去問データは出典に解説が無いため、必ず自作すること）`);
  }
});

if (errors.length > 0) {
  console.error(`問題データに ${errors.length} 件のエラーがあります:\n`);
  errors.forEach((e) => console.error(" - " + e));
  process.exit(1);
} else {
  console.log(`OK: ${QUESTIONS.length} 件の設問を検証、エラーなし。`);
}
