export interface PredictionObservation {
  prediction_id: string;
  expected: number;
  observed: number;
  minimum: number;
  maximum: number;
  importance: number;
  evidence_ids: string[];
  predicted_at: string;
  observed_at: string;
}

export interface PredictionError extends PredictionObservation {
  absolute_error: number;
  normalized_error: number;
  weighted_error: number;
}

export interface PredictionEvaluation {
  errors: PredictionError[];
  aggregate_error: number;
  deliberation_threshold: number;
  recommend_deliberation: boolean;
}

function unit(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a finite number from 0 to 1.`);
  }
}

/** Evaluates an explicit prediction against an observation without mutating the world model. */
export function evaluatePredictions(
  observations: PredictionObservation[],
  deliberationThreshold = 0.35,
): PredictionEvaluation {
  unit(deliberationThreshold, 'deliberationThreshold');
  if (observations.length === 0 || observations.length > 10_000) {
    throw new Error('observations must contain from 1 to 10000 entries.');
  }
  if (new Set(observations.map((entry) => entry.prediction_id)).size !== observations.length) {
    throw new Error('prediction_id values must be unique.');
  }

  let importanceTotal = 0;
  const errors = observations.map((entry): PredictionError => {
    if (!entry.prediction_id) throw new Error('Every prediction needs a prediction_id.');
    if (!Number.isFinite(entry.minimum) || !Number.isFinite(entry.maximum)) {
      throw new Error(`Prediction '${entry.prediction_id}' has a non-finite range.`);
    }
    if (entry.maximum <= entry.minimum) {
      throw new Error(
        `Prediction '${entry.prediction_id}' must have maximum greater than minimum.`,
      );
    }
    if (
      !Number.isFinite(entry.expected) ||
      !Number.isFinite(entry.observed) ||
      entry.expected < entry.minimum ||
      entry.expected > entry.maximum ||
      entry.observed < entry.minimum ||
      entry.observed > entry.maximum
    ) {
      throw new Error(`Prediction '${entry.prediction_id}' values must be inside its scale.`);
    }
    unit(entry.importance, `prediction.${entry.prediction_id}.importance`);
    if (entry.evidence_ids.length === 0) {
      throw new Error(`Prediction '${entry.prediction_id}' needs evidence.`);
    }
    const predictedAt = Date.parse(entry.predicted_at);
    const observedAt = Date.parse(entry.observed_at);
    if (!Number.isFinite(predictedAt) || !Number.isFinite(observedAt) || observedAt < predictedAt) {
      throw new Error(`Prediction '${entry.prediction_id}' has an invalid temporal order.`);
    }
    const absoluteError = Math.abs(entry.observed - entry.expected);
    const normalizedError = absoluteError / (entry.maximum - entry.minimum);
    importanceTotal += entry.importance;
    return {
      ...entry,
      absolute_error: absoluteError,
      normalized_error: normalizedError,
      weighted_error: normalizedError * entry.importance,
    };
  });

  const aggregateError =
    importanceTotal > 0
      ? errors.reduce((sum, entry) => sum + entry.weighted_error, 0) / importanceTotal
      : errors.reduce((sum, entry) => sum + entry.normalized_error, 0) / errors.length;
  return {
    errors,
    aggregate_error: aggregateError,
    deliberation_threshold: deliberationThreshold,
    recommend_deliberation: aggregateError >= deliberationThreshold,
  };
}
