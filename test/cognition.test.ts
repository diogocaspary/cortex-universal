import { describe, expect, it } from 'vitest';
import { selectAttention, type AttentionCandidate } from '../src/cognition/attention.js';
import { proposeConsolidation } from '../src/cognition/consolidation.js';
import { validateCognitiveCycle, type CognitiveStep } from '../src/cognition/cycle.js';
import { assessCalibration, selectCognitiveMode } from '../src/cognition/metacognition.js';
import { evaluatePredictions } from '../src/cognition/world-model.js';

const observedAt = '2026-08-09T12:00:00.000Z';

function candidate(id: string, values: Partial<AttentionCandidate> = {}): AttentionCandidate {
  return {
    id,
    relevance: 0.5,
    goal_alignment: 0.5,
    novelty: 0.5,
    urgency: 0.5,
    uncertainty: 0.5,
    classification: 'internal',
    source_ids: [`source:${id}`],
    observed_at: observedAt,
    ...values,
  };
}

describe('governed cognitive primitives', () => {
  it('selects a bounded working set deterministically and retains provenance', () => {
    const result = selectAttention(
      [candidate('b'), candidate('urgent', { urgency: 1, relevance: 1 }), candidate('a')],
      2,
    );
    expect(result.selected.map((entry) => entry.id)).toEqual(['urgent', 'a']);
    expect(result.deferred.map((entry) => entry.id)).toEqual(['b']);
    expect(result.selected[0]?.source_ids).toEqual(['source:urgent']);
    expect(result.selected).toHaveLength(2);
  });

  it('keeps attention weights bounded and rejects duplicate candidates', () => {
    expect(() =>
      selectAttention([candidate('one')], 1, {
        relevance: 0,
        goal_alignment: 0,
        novelty: 0,
        urgency: 0,
        uncertainty: 0,
      }),
    ).toThrow('positive');
    expect(() => selectAttention([candidate('one'), candidate('one')], 1)).toThrow('unique');
  });

  it('compares prediction and observation and escalates a large error', () => {
    const result = evaluatePredictions(
      [
        {
          prediction_id: 'prediction:1',
          expected: 90,
          observed: 10,
          minimum: 0,
          maximum: 100,
          importance: 1,
          evidence_ids: ['evidence:1'],
          predicted_at: '2026-08-09T10:00:00.000Z',
          observed_at: '2026-08-09T11:00:00.000Z',
        },
      ],
      0.35,
    );
    expect(result.aggregate_error).toBeCloseTo(0.8);
    expect(result.recommend_deliberation).toBe(true);
  });

  it('rejects predictions with impossible scales or temporal order', () => {
    expect(() =>
      evaluatePredictions([
        {
          prediction_id: 'prediction:bad',
          expected: 0,
          observed: 0,
          minimum: 1,
          maximum: 1,
          importance: 1,
          evidence_ids: ['evidence:1'],
          predicted_at: '2026-08-09T12:00:00.000Z',
          observed_at: '2026-08-09T11:00:00.000Z',
        },
      ]),
    ).toThrow('maximum greater');
  });

  it('measures confidence calibration separately from accuracy', () => {
    const perfect = assessCalibration(
      [
        { id: 'correct', confidence: 1, correct: true, evidence_ids: ['e:1'] },
        { id: 'wrong', confidence: 0, correct: false, evidence_ids: ['e:2'] },
      ],
      2,
    );
    expect(perfect.accuracy).toBe(0.5);
    expect(perfect.brier_score).toBe(0);
    expect(perfect.expected_calibration_error).toBe(0);

    const overconfident = assessCalibration(
      [{ id: 'bad', confidence: 1, correct: false, evidence_ids: ['e:3'] }],
      2,
    );
    expect(overconfident.brier_score).toBe(1);
    expect(overconfident.calibration_bias).toBe(1);
  });

  it('uses risk and uncertainty to switch to deliberative processing', () => {
    expect(
      selectCognitiveMode({ risk: 1, uncertainty: 1, conflict: 1, prediction_error: 1 }).mode,
    ).toBe('deliberative');
    expect(
      selectCognitiveMode({ risk: 0, uncertainty: 0, conflict: 0, prediction_error: 0 }).mode,
    ).toBe('fast');
  });

  it('proposes replay without writing trusted memory', () => {
    const proposal = proposeConsolidation(
      [
        {
          id: 'ordinary',
          recency: 0.5,
          surprise: 0.1,
          salience: 0.2,
          goal_relevance: 0.2,
          evidence_quality: 0.8,
          source_memory_ids: ['memory:1'],
          classification: 'internal',
          observed_at: observedAt,
        },
        {
          id: 'important',
          recency: 1,
          surprise: 1,
          salience: 1,
          goal_relevance: 1,
          evidence_quality: 1,
          source_memory_ids: ['memory:2'],
          classification: 'confidential',
          observed_at: observedAt,
        },
      ],
      1,
    );
    expect(proposal.selected[0]?.id).toBe('important');
    expect(proposal.status).toBe('review_required');
    expect(proposal.writes_performed).toBe(0);
  });

  it('validates explicit cognitive transitions and permits abstention', () => {
    const steps: CognitiveStep[] = [
      {
        sequence: 1,
        stage: 'perceive',
        occurred_at: '2026-08-09T10:00:00.000Z',
        input_ids: ['input:1'],
        output_ids: ['percept:1'],
        evidence_ids: ['source:1'],
      },
      {
        sequence: 2,
        stage: 'abstain',
        occurred_at: '2026-08-09T10:00:01.000Z',
        input_ids: ['percept:1'],
        output_ids: ['gap:1'],
        evidence_ids: ['source:1'],
      },
    ];
    expect(
      validateCognitiveCycle(steps, {
        status: 'abstained',
        started_at: '2026-08-09T09:59:59.000Z',
        completed_at: '2026-08-09T10:00:02.000Z',
      }),
    ).toEqual({ valid: true, errors: [] });
    expect(
      validateCognitiveCycle(steps, {
        status: 'completed',
        started_at: '2026-08-09T09:59:59.000Z',
        completed_at: '2026-08-09T10:00:02.000Z',
      }).valid,
    ).toBe(false);
    expect(validateCognitiveCycle([{ ...steps[0]!, stage: 'retrieve' }]).valid).toBe(false);
  });
});
