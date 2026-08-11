/**
 * Function words carry no discriminative weight in a query. They are removed from the query
 * only; the index keeps every token, so an exact lookup for one of these still works.
 */
const QUERY_STOPWORDS = new Set([
  // pt-BR determiners, prepositions and contractions
  'os',
  'as',
  'um',
  'uma',
  'uns',
  'umas',
  'ao',
  'aos',
  'da',
  'do',
  'das',
  'dos',
  'na',
  'no',
  'nas',
  'nos',
  'num',
  'numa',
  'pelo',
  'pela',
  'pelos',
  'pelas',
  'de',
  'em',
  'por',
  'para',
  'pra',
  'com',
  'sem',
  'sob',
  'sobre',
  'entre',
  'ate',
  'até',
  'apos',
  'após',
  'desde',
  // pt-BR conjunctions and interrogatives
  'ou',
  'mas',
  'porem',
  'porém',
  'porque',
  'pois',
  'como',
  'quando',
  'se',
  'que',
  'qual',
  'quais',
  'quem',
  'onde',
  'quanto',
  'quantos',
  'quanta',
  'quantas',
  'enquanto',
  'portanto',
  // pt-BR pronouns and demonstratives
  'eu',
  'tu',
  'ele',
  'ela',
  'eles',
  'elas',
  'voce',
  'você',
  'voces',
  'vocês',
  'me',
  'te',
  'lhe',
  'lhes',
  'meu',
  'minha',
  'meus',
  'minhas',
  'teu',
  'tua',
  'seu',
  'sua',
  'seus',
  'suas',
  'nosso',
  'nossa',
  'nossos',
  'nossas',
  'este',
  'esta',
  'estes',
  'estas',
  'esse',
  'essa',
  'esses',
  'essas',
  'aquele',
  'aquela',
  'aqueles',
  'aquelas',
  'isso',
  'isto',
  'aquilo',
  // pt-BR copulas, auxiliaries and common adverbs
  'ser',
  'sou',
  'sao',
  'são',
  'era',
  'eram',
  'foi',
  'foram',
  'seja',
  'sejam',
  'esta',
  'está',
  'estao',
  'estão',
  'estava',
  'estar',
  'ter',
  'tem',
  'têm',
  'tinha',
  'haver',
  'ha',
  'há',
  'havia',
  'nao',
  'não',
  'sim',
  'ja',
  'já',
  'tambem',
  'também',
  'muito',
  'mais',
  'menos',
  // English function words, for mixed-language corpora. Short ones matter: the length filter
  // above only drops single characters, so 'is' and 'to' would otherwise survive as query terms.
  'is',
  'be',
  'to',
  'of',
  'in',
  'on',
  'at',
  'by',
  'or',
  'if',
  'it',
  'an',
  'we',
  'so',
  'up',
  'my',
  'he',
  'were',
  'being',
  'both',
  'same',
  'such',
  'very',
  'too',
  'own',
  'the',
  'and',
  'for',
  'are',
  'but',
  'not',
  'you',
  'all',
  'can',
  'was',
  'has',
  'had',
  'have',
  'does',
  'did',
  'what',
  'which',
  'when',
  'where',
  'who',
  'how',
  'why',
  'with',
  'from',
  'this',
  'that',
  'these',
  'those',
  'there',
  'their',
  'they',
  'them',
  'its',
  'his',
  'her',
  'will',
  'would',
  'should',
  'could',
  'been',
  'into',
  'about',
  'over',
  'than',
  'then',
]);

/**
 * Deterministic query tokenizer shared by every storage adapter, so two backends cannot
 * disagree about what a query means.
 */
export function searchTokens(value: string): string[] {
  return [
    ...new Set(
      (
        value
          .normalize('NFKC')
          .toLocaleLowerCase('pt-BR')
          .match(/[\p{L}\p{N}_-]+/gu) ?? []
      )
        .filter((token) => token.length > 1)
        .slice(0, 24),
    ),
  ];
}

/**
 * Query tokens without function words. A query made only of function words keeps its raw
 * tokens, so the channel degrades to a weak match instead of falling silent.
 */
export function queryTokens(value: string): string[] {
  const tokens = searchTokens(value);
  const meaningful = tokens.filter((token) => !QUERY_STOPWORDS.has(token));
  return meaningful.length > 0 ? meaningful : tokens;
}

/**
 * Distância de cosseno máxima para um vizinho contar como evidência.
 *
 * Sem teto, a busca vetorial devolve os N mais próximos **sempre**, por mais distantes que
 * estejam: uma pergunta fora do acervo volta com resultados e sem lacuna, e quem chama não tem
 * como distinguir "achei" de "isto foi o menos ruim". Um cérebro que nunca diz "não sei" ensina
 * o agente a ignorá-lo.
 *
 * O padrão saiu de medição contra um acervo real com text-embedding-3-large@1536:
 * documento correto entre 0,25 e 0,37; documento errado a partir de 0,59; pergunta alheia a
 * partir de 0,70. 0,55 fica no vale, com margem dos dois lados.
 *
 * ⚠️ Distâncias comprimem conforme o acervo cresce e mudam com o modelo de embedding. Meça de
 * novo antes de confiar no padrão em outro corpus: `CORTEX_VECTOR_MAX_DISTANCE` ajusta, e
 * um valor >= 2 desliga o corte (cosseno nunca passa de 2).
 */
export function vectorMaximumDistance(configured?: string): number {
  const value = Number(configured ?? process.env.CORTEX_VECTOR_MAX_DISTANCE ?? '0.55');
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('CORTEX_VECTOR_MAX_DISTANCE must be a positive number.');
  }
  return value;
}

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
