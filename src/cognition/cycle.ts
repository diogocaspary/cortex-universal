export const cognitiveStages = [
  'perceive',
  'attend',
  'retrieve',
  'broadcast',
  'simulate',
  'propose_action',
  'evaluate',
  'propose_consolidation',
  'abstain',
  'complete',
] as const;

export type CognitiveStage = (typeof cognitiveStages)[number];

export interface CognitiveStep {
  sequence: number;
  stage: CognitiveStage;
  occurred_at: string;
  input_ids: string[];
  output_ids: string[];
  evidence_ids: string[];
}

export interface CognitiveCycleBounds {
  status: 'completed' | 'abstained';
  started_at: string;
  completed_at: string;
}

const allowedTransitions: Record<CognitiveStage, CognitiveStage[]> = {
  perceive: ['attend', 'abstain'],
  attend: ['retrieve', 'abstain'],
  retrieve: ['broadcast', 'abstain'],
  broadcast: ['simulate', 'abstain'],
  simulate: ['propose_action', 'abstain'],
  propose_action: ['evaluate', 'abstain'],
  evaluate: ['propose_consolidation', 'complete', 'abstain'],
  propose_consolidation: ['complete', 'abstain'],
  abstain: ['complete'],
  complete: [],
};

/** Checks the auditable cognitive cycle without inventing hidden chain-of-thought content. */
export function validateCognitiveCycle(
  steps: CognitiveStep[],
  bounds?: CognitiveCycleBounds,
): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (steps.length === 0)
    return { valid: false, errors: ['A cognitive cycle needs at least one step.'] };
  if (steps[0]?.stage !== 'perceive') errors.push('The first cognitive stage must be perceive.');
  let previousTime = Number.NEGATIVE_INFINITY;
  steps.forEach((step, index) => {
    if (step.sequence !== index + 1)
      errors.push(`Step ${index + 1} has a non-contiguous sequence.`);
    const time = Date.parse(step.occurred_at);
    if (!Number.isFinite(time)) errors.push(`Step ${index + 1} has an invalid occurred_at.`);
    if (time < previousTime) errors.push(`Step ${index + 1} occurs before its predecessor.`);
    previousTime = time;
    if (index > 0) {
      const previous = steps[index - 1]!.stage;
      if (!allowedTransitions[previous].includes(step.stage)) {
        errors.push(`Transition ${previous} -> ${step.stage} is not allowed.`);
      }
    }
  });
  if (!new Set(['complete', 'abstain']).has(steps.at(-1)!.stage)) {
    errors.push('The final stage must be complete or abstain.');
  }
  if (bounds) {
    const startedAt = Date.parse(bounds.started_at);
    const completedAt = Date.parse(bounds.completed_at);
    if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
      errors.push('The cognitive cycle has an invalid time window.');
    } else {
      const firstStepAt = Date.parse(steps[0]!.occurred_at);
      const lastStepAt = Date.parse(steps.at(-1)!.occurred_at);
      if (Number.isFinite(firstStepAt) && firstStepAt < startedAt) {
        errors.push('The first step occurs before the cycle start.');
      }
      if (Number.isFinite(lastStepAt) && lastStepAt > completedAt) {
        errors.push('The final step occurs after the cycle completion time.');
      }
    }
    const abstained = steps.some((step) => step.stage === 'abstain');
    if (bounds.status === 'completed' && (steps.at(-1)!.stage !== 'complete' || abstained)) {
      errors.push('A completed cycle must end at complete without an abstention step.');
    }
    if (bounds.status === 'abstained' && !abstained) {
      errors.push('An abstained cycle must contain an abstention step.');
    }
  }
  return { valid: errors.length === 0, errors };
}
