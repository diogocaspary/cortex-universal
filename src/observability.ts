import { createHash, randomUUID } from 'node:crypto';
import { metrics, trace, SpanStatusCode } from '@opentelemetry/api';

interface OperationAggregate {
  requests: number;
  errors: number;
  duration_ms_total: number;
  duration_ms_max: number;
}

export interface TraceContext {
  request_id: string;
  trace_id: string;
  correlation_id: string;
}

export interface SanitizedFailure {
  failure_id: string;
  occurred_at: string;
  operation: string;
  status_code: number;
  error_code: string;
  error_fingerprint: string;
  request_id: string;
  trace_id: string;
  correlation_id: string;
}

export interface MetricsSnapshot {
  generated_at: string;
  process_uptime_seconds: number;
  operations: Record<
    string,
    OperationAggregate & { duration_ms_average: number; error_rate: number }
  >;
}

const EXTERNAL_CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u;

function sanitizedCode(value: string): string {
  return /^[a-z][a-z0-9_]{2,63}$/u.test(value) ? value : 'unclassified_failure';
}

/**
 * Payload-free telemetry. Trace identifiers are created inside the trust boundary;
 * caller correlation identifiers are accepted only under a narrow syntax contract.
 */
export class CortexObservability {
  readonly #operations = new Map<string, OperationAggregate>();
  readonly #failures: SanitizedFailure[] = [];
  readonly #maximumFailures: number;
  readonly #requestCounter = metrics
    .getMeter('cortex-universal')
    .createCounter('cortex.http.server.requests', { unit: '{request}' });
  readonly #duration = metrics
    .getMeter('cortex-universal')
    .createHistogram('cortex.http.server.duration', { unit: 'ms' });
  readonly #failureCounter = metrics
    .getMeter('cortex-universal')
    .createCounter('cortex.failures', { unit: '{failure}' });
  readonly #tracer = trace.getTracer('cortex-universal');

  constructor(maximumFailures = 500) {
    if (!Number.isInteger(maximumFailures) || maximumFailures < 10 || maximumFailures > 10_000) {
      throw new Error('Failure buffer size must be an integer from 10 to 10000.');
    }
    this.#maximumFailures = maximumFailures;
  }

  createContext(requestId: string, externalCorrelationId?: string): TraceContext {
    const traceId = `trace:${randomUUID()}`;
    return {
      request_id: `request:${requestId}`,
      trace_id: traceId,
      correlation_id:
        externalCorrelationId && EXTERNAL_CORRELATION_PATTERN.test(externalCorrelationId)
          ? externalCorrelationId
          : traceId.replace(/^trace:/u, 'correlation:'),
    };
  }

  record(operation: string, statusCode: number, durationMs: number): void {
    const current = this.#operations.get(operation) ?? {
      requests: 0,
      errors: 0,
      duration_ms_total: 0,
      duration_ms_max: 0,
    };
    current.requests += 1;
    if (statusCode >= 400) current.errors += 1;
    current.duration_ms_total += durationMs;
    current.duration_ms_max = Math.max(current.duration_ms_max, durationMs);
    this.#operations.set(operation, current);
    const attributes = { 'http.route': operation, 'http.response.status_code': statusCode };
    this.#requestCounter.add(1, attributes);
    this.#duration.record(durationMs, attributes);
  }

  recordFailure(
    context: TraceContext,
    operation: string,
    statusCode: number,
    errorCode: string,
    error: unknown,
  ): SanitizedFailure {
    const message = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    const failure: SanitizedFailure = {
      failure_id: `failure:${randomUUID()}`,
      occurred_at: new Date().toISOString(),
      operation,
      status_code: statusCode,
      error_code: sanitizedCode(errorCode),
      error_fingerprint: `sha256:${createHash('sha256').update(message, 'utf8').digest('hex')}`,
      request_id: context.request_id,
      trace_id: context.trace_id,
      correlation_id: context.correlation_id,
    };
    this.#failures.push(failure);
    if (this.#failures.length > this.#maximumFailures) this.#failures.shift();
    this.#failureCounter.add(1, {
      operation,
      error_code: failure.error_code,
      'http.response.status_code': statusCode,
    });
    return structuredClone(failure);
  }

  failures(limit = 100): SanitizedFailure[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > this.#maximumFailures) {
      throw new Error(`Failure limit must be an integer from 1 to ${this.#maximumFailures}.`);
    }
    return this.#failures
      .slice(-limit)
      .reverse()
      .map((failure) => structuredClone(failure));
  }

  async traced<T>(
    name: string,
    context: TraceContext,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    return this.#tracer.startActiveSpan(name, async (span) => {
      span.setAttributes({
        'cortex.trace_id': context.trace_id,
        'cortex.request_id': context.request_id,
        'cortex.correlation_id': context.correlation_id,
      });
      try {
        const result = await operation();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  snapshot(): MetricsSnapshot {
    return {
      generated_at: new Date().toISOString(),
      process_uptime_seconds: process.uptime(),
      operations: Object.fromEntries(
        [...this.#operations.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([operation, value]) => [
            operation,
            {
              ...value,
              duration_ms_average:
                value.requests > 0 ? value.duration_ms_total / value.requests : 0,
              error_rate: value.requests > 0 ? value.errors / value.requests : 0,
            },
          ]),
      ),
    };
  }
}
