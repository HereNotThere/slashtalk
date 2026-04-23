import type { Analyzer } from "./types";
import { summaryAnalyzer } from "./summary";
import { rollingSummaryAnalyzer } from "./rolling-summary";

export const analyzers: Array<Analyzer> = [
  summaryAnalyzer,
  rollingSummaryAnalyzer,
];
