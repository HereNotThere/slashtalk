export const SUMMARY_ANALYZER = "summary" as const;
export const ROLLING_SUMMARY_ANALYZER = "rolling_summary" as const;

export type AnalyzerName = typeof SUMMARY_ANALYZER | typeof ROLLING_SUMMARY_ANALYZER;
