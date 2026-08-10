export interface ReplayCandidate {
  id: string;
  recency: number;
  surprise: number;
  salience: number;
  goal_relevance: number;
  evidence_quality: number;
  source_memory_ids: string[];
  classification: 'public' | 'internal' | 'confidential' | 'restricted';
  observed_at: string;
}

export interface RankedReplayCandidate extends ReplayCandidate {
  replay_score: number;
}

export interface ConsolidationProposal {
  selected: RankedReplayCandidate[];
  deferred: RankedReplayCandidate[];
  status: 'review_required';
  writes_performed: 0;
}

function unit(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a finite number from 0 to 1.`);
  }
}

/**
 * Ranks episodic traces for offline replay. It only creates a reviewable proposal and never writes
 * semantic or procedural memory.
 */
export function proposeConsolidation(
  candidates: ReplayCandidate[],
  batchSize: number,
): ConsolidationProposal {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error('batchSize must be an integer from 1 to 100.');
  }
  if (candidates.length === 0 || candidates.length > 10_000) {
    throw new Error('candidates must contain from 1 to 10000 entries.');
  }
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    throw new Error('Replay candidate ids must be unique.');
  }
  const ranked = candidates
    .map((candidate): RankedReplayCandidate => {
      if (!candidate.id) throw new Error('Every replay candidate needs an id.');
      for (const field of [
        'recency',
        'surprise',
        'salience',
        'goal_relevance',
        'evidence_quality',
      ] as const) {
        unit(candidate[field], `candidate.${candidate.id}.${field}`);
      }
      if (candidate.source_memory_ids.length === 0) {
        throw new Error(`Replay candidate '${candidate.id}' needs a source memory.`);
      }
      if (!Number.isFinite(Date.parse(candidate.observed_at))) {
        throw new Error(`Replay candidate '${candidate.id}' has an invalid observed_at.`);
      }
      return {
        ...candidate,
        replay_score:
          candidate.surprise * 0.25 +
          candidate.salience * 0.2 +
          candidate.goal_relevance * 0.2 +
          candidate.evidence_quality * 0.25 +
          candidate.recency * 0.1,
      };
    })
    .sort(
      (left, right) => right.replay_score - left.replay_score || left.id.localeCompare(right.id),
    );
  return {
    selected: ranked.slice(0, batchSize),
    deferred: ranked.slice(batchSize),
    status: 'review_required',
    writes_performed: 0,
  };
}
