interface MetricCounter {
  [key: string]: number;
}

interface MetricSummary {
  count: number;
  totalMs: number;
  averageMs: number;
}

interface LatencyMetrics {
  [key: string]: MetricSummary;
}

export class X402Metrics {
  private counters: MetricCounter = {
    // Escrow route counters
    'escrow.attempt': 0,
    'escrow.success': 0,
    'escrow.error.402': 0,
    'escrow.error.400': 0,
    'escrow.error.500': 0,
    
    // Facilitator verify counters
    'facilitator.verify.attempt': 0,
    'facilitator.verify.success': 0,
    'facilitator.verify.failure': 0,
    'facilitator.verify.real': 0,
    'facilitator.verify.simulated': 0,

    // Facilitator settle counters
    'facilitator.settle.attempt': 0,
    'facilitator.settle.success': 0,
    'facilitator.settle.failure': 0,
    'facilitator.settle.real': 0,
    'facilitator.settle.simulated': 0,
  };

  private latencies: LatencyMetrics = {
    'facilitator.verify': { count: 0, totalMs: 0, averageMs: 0 },
    'facilitator.settle': { count: 0, totalMs: 0, averageMs: 0 },
  };

  increment(metricName: string) {
    if (this.counters[metricName] !== undefined) {
      this.counters[metricName]++;
    } else {
      this.counters[metricName] = 1;
    }
  }

  recordLatency(metricName: string, durationMs: number) {
    if (!this.latencies[metricName]) {
      this.latencies[metricName] = { count: 0, totalMs: 0, averageMs: 0 };
    }
    const entry = this.latencies[metricName];
    entry.count++;
    entry.totalMs += durationMs;
    entry.averageMs = entry.totalMs / entry.count;
  }

  snapshot() {
    return {
      timestamp: new Date().toISOString(),
      counters: { ...this.counters },
      latencies: JSON.parse(JSON.stringify(this.latencies)),
    };
  }
}

export const x402Metrics = new X402Metrics();
