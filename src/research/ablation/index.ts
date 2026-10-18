export { DEFAULT_ABLATION_CONFIG } from './config.js';
export { canonicalJson, fingerprintCandles, hashOfConfig, sha256 } from './fingerprint.js';
export { atrPctAt, computeMetrics, excursionR, riskUnitR, sessionOf, splitStats, tradesOf, type TradeInputs } from './metrics.js';
export { costCurve, delayedExpectancy, flipMeanR, permutationTest, segmentBounds, segmentOf, type PermutationResult, type Segment } from './stats.js';
export { buildVariant, buildVariants, componentCatalog, componentKey, type Selection } from './variants.js';
export { reportMd, runAblationStudy, studyIdOf, type StudyInput } from './study.js';
export * from './types.js';
