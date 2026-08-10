export interface RankedItem {
  id: string;
}

export interface RankedChannel {
  name: string;
  weight: number;
  items: RankedItem[];
}

export interface FusionContribution {
  channel: string;
  rank: number;
  contribution: number;
}

export interface FusedResult {
  id: string;
  score: number;
  contributions: FusionContribution[];
}

export interface GapCandidate {
  id: string;
  citations: string[];
  valid_until: string | null;
  contradicts: string[];
}

export interface KnowledgeGap {
  code: 'no_results' | 'uncited_result' | 'stale_result' | 'contradictory_results';
  message: string;
  related_ids: string[];
}

/** Deterministic weighted Reciprocal Rank Fusion for keyword, vector, and graph channels. */
export function reciprocalRankFusion(
  channels: RankedChannel[],
  options: { rankConstant?: number; limit?: number } = {},
): FusedResult[] {
  const rankConstant = options.rankConstant ?? 60;
  const limit = options.limit ?? 20;
  if (!Number.isFinite(rankConstant) || rankConstant <= 0) {
    throw new Error('rankConstant must be a positive finite number.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('limit must be an integer from 1 to 1000.');
  }
  if (new Set(channels.map((channel) => channel.name)).size !== channels.length) {
    throw new Error('Retrieval channel names must be unique.');
  }

  const fused = new Map<string, FusedResult>();
  for (const channel of channels) {
    if (!channel.name || !Number.isFinite(channel.weight) || channel.weight <= 0) {
      throw new Error('Every retrieval channel needs a name and a positive finite weight.');
    }
    const seen = new Set<string>();
    channel.items.forEach((item, index) => {
      if (!item.id || seen.has(item.id)) return;
      seen.add(item.id);
      const rank = index + 1;
      const contribution = channel.weight / (rankConstant + rank);
      const current = fused.get(item.id) ?? { id: item.id, score: 0, contributions: [] };
      current.score += contribution;
      current.contributions.push({ channel: channel.name, rank, contribution });
      fused.set(item.id, current);
    });
  }

  return [...fused.values()]
    .map((result) => ({
      ...result,
      contributions: result.contributions.sort((left, right) =>
        left.channel.localeCompare(right.channel),
      ),
    }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
}

/** Produces explicit uncertainty signals without asking an LLM to invent missing evidence. */
export function detectKnowledgeGaps(candidates: GapCandidate[], asOf: string): KnowledgeGap[] {
  const asOfTime = Date.parse(asOf);
  if (!Number.isFinite(asOfTime)) throw new Error('asOf must be an ISO date-time.');
  if (candidates.length === 0) {
    return [
      {
        code: 'no_results',
        message: 'No authorized evidence matched the request.',
        related_ids: [],
      },
    ];
  }

  const gaps: KnowledgeGap[] = [];
  for (const candidate of candidates) {
    if (candidate.citations.length === 0) {
      gaps.push({
        code: 'uncited_result',
        message: 'A result has no supporting citation.',
        related_ids: [candidate.id],
      });
    }
    const validUntilTime = candidate.valid_until ? Date.parse(candidate.valid_until) : null;
    if (candidate.valid_until && !Number.isFinite(validUntilTime)) {
      throw new Error(`Candidate '${candidate.id}' has an invalid valid_until date-time.`);
    }
    if (validUntilTime !== null && validUntilTime <= asOfTime) {
      gaps.push({
        code: 'stale_result',
        message: 'A result is outside its validity window.',
        related_ids: [candidate.id],
      });
    }
    const conflicts = [
      ...new Set(candidate.contradicts.filter((id) => candidates.some((other) => other.id === id))),
    ];
    if (conflicts.length > 0) {
      gaps.push({
        code: 'contradictory_results',
        message: 'Authorized evidence contains an explicit contradiction.',
        related_ids: [candidate.id, ...conflicts].sort(),
      });
    }
  }

  const seen = new Set<string>();
  return gaps.filter((gap) => {
    const key = `${gap.code}:${gap.related_ids.join('|')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
