export interface ConfidenceSample {
  id: string;
  confidence: number;
  correct: boolean;
  evidence_ids: string[];
}

export interface CalibrationBin {
  lower_bound: number;
  upper_bound: number;
  count: number;
  mean_confidence: number;
  accuracy: number;
  absolute_gap: number;
}

export interface CalibrationAssessment {
  sample_count: number;
  accuracy: number;
  mean_confidence: number;
  calibration_bias: number;
  brier_score: number;
  expected_calibration_error: number;
  bins: CalibrationBin[];
}

export interface CognitiveModeSignals {
  risk: number;
  uncertainty: number;
  conflict: number;
  prediction_error: number;
}

function unit(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a finite number from 0 to 1.`);
  }
}

/** Measures calibration separately from task accuracy, including confidence bias and Brier score. */
export function assessCalibration(
  samples: ConfidenceSample[],
  binCount = 10,
): CalibrationAssessment {
  if (samples.length === 0 || samples.length > 10_000) {
    throw new Error('samples must contain from 1 to 10000 entries.');
  }
  if (!Number.isInteger(binCount) || binCount < 2 || binCount > 20) {
    throw new Error('binCount must be an integer from 2 to 20.');
  }
  if (new Set(samples.map((sample) => sample.id)).size !== samples.length) {
    throw new Error('Confidence sample ids must be unique.');
  }
  samples.forEach((sample) => {
    if (!sample.id) throw new Error('Every confidence sample needs an id.');
    unit(sample.confidence, `sample.${sample.id}.confidence`);
    if (sample.evidence_ids.length === 0) {
      throw new Error(`Confidence sample '${sample.id}' needs evidence.`);
    }
  });

  const accuracy = samples.filter((sample) => sample.correct).length / samples.length;
  const meanConfidence =
    samples.reduce((sum, sample) => sum + sample.confidence, 0) / samples.length;
  const brierScore =
    samples.reduce((sum, sample) => sum + (sample.confidence - (sample.correct ? 1 : 0)) ** 2, 0) /
    samples.length;
  const bins: CalibrationBin[] = [];
  for (let index = 0; index < binCount; index += 1) {
    const lower = index / binCount;
    const upper = (index + 1) / binCount;
    const entries = samples.filter(
      (sample) =>
        sample.confidence >= lower &&
        (index === binCount - 1 ? sample.confidence <= upper : sample.confidence < upper),
    );
    if (entries.length === 0) continue;
    const binConfidence =
      entries.reduce((sum, sample) => sum + sample.confidence, 0) / entries.length;
    const binAccuracy = entries.filter((sample) => sample.correct).length / entries.length;
    bins.push({
      lower_bound: lower,
      upper_bound: upper,
      count: entries.length,
      mean_confidence: binConfidence,
      accuracy: binAccuracy,
      absolute_gap: Math.abs(binConfidence - binAccuracy),
    });
  }
  const expectedCalibrationError = bins.reduce(
    (sum, bin) => sum + (bin.count / samples.length) * bin.absolute_gap,
    0,
  );
  return {
    sample_count: samples.length,
    accuracy,
    mean_confidence: meanConfidence,
    calibration_bias: meanConfidence - accuracy,
    brier_score: brierScore,
    expected_calibration_error: expectedCalibrationError,
    bins,
  };
}

/** A conservative fast/deliberative gate; it is an operational heuristic, not a theory of mind. */
export function selectCognitiveMode(
  signals: CognitiveModeSignals,
  threshold = 0.45,
): { mode: 'fast' | 'deliberative'; score: number; reasons: string[] } {
  unit(threshold, 'threshold');
  Object.entries(signals).forEach(([field, value]) => unit(value, field));
  const weights: CognitiveModeSignals = {
    risk: 0.35,
    uncertainty: 0.25,
    conflict: 0.2,
    prediction_error: 0.2,
  };
  const score = Object.entries(signals).reduce(
    (sum, [field, value]) => sum + value * weights[field as keyof CognitiveModeSignals],
    0,
  );
  const reasons = Object.entries(signals)
    .filter(([, value]) => value >= threshold)
    .map(([field]) => field)
    .sort();
  return { mode: score >= threshold ? 'deliberative' : 'fast', score, reasons };
}
