// Minimal observability: structured JSON logs and Prometheus-format counters/histograms.
// Deliberately dependency-free — the shapes match prom-client/OTel conventions, so swapping in a
// real library later is a drop-in change rather than a rewrite of every call site.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? 'info'] ?? LEVELS.info;

// Never log these, wherever they appear in a fields object.
const REDACTED = new Set(['secret', 'apiKey', 'api_key', 'password', 'authorization', 'key_hash']);

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = REDACTED.has(k) ? '[redacted]' : v;
  }
  return out;
}

function emit(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < MIN_LEVEL) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...redact(fields) });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};

// ---- metrics ---------------------------------------------------------------------------------

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}="${String(labels[k]).replace(/"/g, '')}"`).join(',');
}

class Counter {
  readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) {
      lines.push(key ? `${this.name}{${key}} ${value}` : `${this.name} ${value}`);
    }
    return lines.join('\n');
  }
}

// Fixed buckets (seconds) suitable for API latency; p95 is derived by the scraper.
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

class Histogram {
  private readonly buckets = new Map<string, number[]>();
  private readonly sums = new Map<string, number>();
  private readonly counts = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  observe(seconds: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    const b = this.buckets.get(key) ?? new Array(BUCKETS.length).fill(0);
    for (let i = 0; i < BUCKETS.length; i++) {
      if (seconds <= BUCKETS[i]!) b[i]! += 1;
    }
    this.buckets.set(key, b);
    this.sums.set(key, (this.sums.get(key) ?? 0) + seconds);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, b] of this.buckets) {
      const prefix = key ? `${key},` : '';
      for (let i = 0; i < BUCKETS.length; i++) {
        lines.push(`${this.name}_bucket{${prefix}le="${BUCKETS[i]}"} ${b[i]}`);
      }
      lines.push(`${this.name}_bucket{${prefix}le="+Inf"} ${this.counts.get(key) ?? 0}`);
      lines.push(key ? `${this.name}_sum{${key}} ${this.sums.get(key) ?? 0}` : `${this.name}_sum ${this.sums.get(key) ?? 0}`);
      lines.push(key ? `${this.name}_count{${key}} ${this.counts.get(key) ?? 0}` : `${this.name}_count ${this.counts.get(key) ?? 0}`);
    }
    return lines.join('\n');
  }
}

export const metrics = {
  httpRequests: new Counter('ratchet_http_requests_total', 'HTTP requests by route and status'),
  httpDuration: new Histogram('ratchet_http_request_seconds', 'HTTP request duration in seconds'),
  eventsIngested: new Counter('ratchet_events_ingested_total', 'Events accepted by the ingest API'),
  tasksCreated: new Counter('ratchet_tasks_created_total', 'Tasks created by the pipeline'),
  pipelineMessages: new Counter('ratchet_pipeline_messages_total', 'Stream messages processed'),
  pipelineErrors: new Counter('ratchet_pipeline_errors_total', 'Pipeline message failures'),
  outboxRedriven: new Counter('ratchet_outbox_redriven_total', 'Relayed-but-unconsumed outbox rows re-delivered to the stream'),
  webhookDeliveries: new Counter('ratchet_webhook_deliveries_total', 'Webhook deliveries by status'),
  rateLimited: new Counter('ratchet_rate_limited_total', 'Requests rejected by the rate limiter'),
  circuitOpened: new Counter('ratchet_circuit_opened_total', 'Circuit breakers opened'),
  webhookTimeouts: new Counter('ratchet_webhook_timeouts_total', 'Webhook calls that timed out'),
};

export function renderMetrics(): string {
  return (
    [
      metrics.httpRequests,
      metrics.httpDuration,
      metrics.eventsIngested,
      metrics.tasksCreated,
      metrics.pipelineMessages,
      metrics.pipelineErrors,
      metrics.outboxRedriven,
      metrics.webhookDeliveries,
      metrics.rateLimited,
      metrics.circuitOpened,
      metrics.webhookTimeouts,
    ]
      .map((m) => m.render())
      .join('\n') + '\n'
  );
}
