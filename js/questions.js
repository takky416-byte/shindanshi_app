import { SUBJECTS } from "./data/subjects.js";
import { ORIGINAL_QUESTIONS } from "./data/original.js";
import { PASTEXAM_QUESTIONS } from "./data/pastexam/index.js";

export { SUBJECTS };
export const QUESTIONS = [...ORIGINAL_QUESTIONS, ...PASTEXAM_QUESTIONS];
