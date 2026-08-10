export interface AttentionCandidate {
  id: string;
  relevance: number;
  goal_alignment: number;
  novelty: number;
  urgency: number;
  uncertainty: number;
  classification: 'public' | 'internal' | 'confidential' | 'restricted';
  source_ids: string[];
  observed_at: string;
}

export interface AttentionWeights {
  relevance: number;
  goal_alignment: number;
  novelty: number;
  urgency: number;
  uncertainty: number;
}

export interface RankedAttentionCandidate extends AttentionCandidate {
  score: number;
  score_components: AttentionWeights;
}

export interface AttentionSelection {
  selected: RankedAttentionCandidate[];
  deferred: RankedAttentionCandidate[];
  capacity: number;
  weights: AttentionWeights;
}

const defaultWeights: AttentionWeights = {
  relevance: 0.3,
  goal_alignment: 0.25,
  novelty: 0.15,
  urgency: 0.2,
  uncertainty: 0.1,
};

function assertUnitInterval(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a finite number from 0 to 1.`);
  }
}

function normalizeWeights(weights: AttentionWeights): AttentionWeights {
  for (const [field, value] of Object.entries(weights))
    assertUnitInterval(value, `weight.${field}`);
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (total <= 0) throw new Error('At least one attention weight must be positive.');
  return {
    relevance: weights.relevance / total,
    goal_alignment: weights.goal_alignment / total,
    novelty: weights.novelty / total,
    urgency: weights.urgency / total,
    uncertainty: weights.uncertainty / total,
  };
}

/**
 * Selects a bounded working set. Expectation is intentionally not treated as relevance:
 * prediction errors can inform novelty or uncertainty, but goal relevance remains independent.
 */
export function selectAttention(
  candidates: AttentionCandidate[],
  capacity: number,
  requestedWeights: AttentionWeights = defaultWeights,
): AttentionSelection {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) {
    throw new Error('capacity must be an integer from 1 to 100.');
  }
  if (candidates.length > 10_000) throw new Error('At most 10000 candidates are allowed.');
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    throw new Error('Attention candidate ids must be unique.');
  }

  const weights = normalizeWeights(requestedWeights);
  const ranked = candidates
    .map((candidate): RankedAttentionCandidate => {
      if (!candidate.id) throw new Error('Every attention candidate needs an id.');
      for (const field of [
        'relevance',
        'goal_alignment',
        'novelty',
        'urgency',
        'uncertainty',
      ] as const) {
        assertUnitInterval(candidate[field], `candidate.${candidate.id}.${field}`);
      }
      if (candidate.source_ids.length === 0) {
        throw new Error(`Attention candidate '${candidate.id}' needs at least one source id.`);
      }
      if (!Number.isFinite(Date.parse(candidate.observed_at))) {
        throw new Error(`Attention candidate '${candidate.id}' has an invalid observed_at.`);
      }
      const scoreComponents: AttentionWeights = {
        relevance: candidate.relevance * weights.relevance,
        goal_alignment: candidate.goal_alignment * weights.goal_alignment,
        novelty: candidate.novelty * weights.novelty,
        urgency: candidate.urgency * weights.urgency,
        uncertainty: candidate.uncertainty * weights.uncertainty,
      };
      return {
        ...candidate,
        score: Object.values(scoreComponents).reduce((sum, value) => sum + value, 0),
        score_components: scoreComponents,
      };
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

  return {
    selected: ranked.slice(0, capacity),
    deferred: ranked.slice(capacity),
    capacity,
    weights,
  };
}
