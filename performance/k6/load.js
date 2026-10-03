import { loadFixtureManifest } from './lib/fixtures.js';
import { connectionIteration, messageIteration } from './lib/workloads.js';

const manifest = loadFixtureManifest(
  __ENV.FIXTURE_MANIFEST,
  __ENV.PERFORMANCE_RUN_ID,
);
const selectedScenario = __ENV.SCENARIO || 'message-write';
const duration = __ENV.DURATION || '30s';
const actorLimit = manifest.actors.length;

const definitions = {
  seed: {
    executor: 'shared-iterations',
    exec: 'seed',
    vus: Math.min(actorLimit, Number(__ENV.VUS || 1)),
    iterations: Number(__ENV.SEED_MESSAGES || 1),
    maxDuration: __ENV.SEED_MAX_DURATION || '30m',
  },
  connections: {
    executor: 'ramping-vus',
    exec: 'connections',
    startVUs: 0,
    stages: [
      { duration: __ENV.RAMP_DURATION || '10s', target: Math.min(actorLimit, Number(__ENV.VUS || 10)) },
      { duration, target: Math.min(actorLimit, Number(__ENV.VUS || 10)) },
      { duration: __ENV.RAMP_DOWN_DURATION || '5s', target: 0 },
    ],
    gracefulRampDown: '5s',
  },
  'message-write': {
    executor: 'constant-arrival-rate',
    exec: 'messageWrite',
    rate: Number(__ENV.RATE || 5),
    timeUnit: '1s',
    duration,
    preAllocatedVUs: Math.min(actorLimit, Number(__ENV.PREALLOCATED_VUS || 5)),
    maxVUs: Math.min(actorLimit, Number(__ENV.MAX_VUS || actorLimit)),
  },
  fanout: {
    executor: 'constant-vus',
    exec: 'fanout',
    vus: Math.min(actorLimit, Number(__ENV.VUS || actorLimit)),
    duration,
  },
  mixed: {
    executor: 'constant-arrival-rate',
    exec: 'mixed',
    rate: Number(__ENV.RATE || 5),
    timeUnit: '1s',
    duration,
    preAllocatedVUs: Math.min(actorLimit, Number(__ENV.PREALLOCATED_VUS || 5)),
    maxVUs: Math.min(actorLimit, Number(__ENV.MAX_VUS || actorLimit)),
  },
  spike: {
    executor: 'ramping-arrival-rate',
    exec: 'spike',
    startRate: 1,
    timeUnit: '1s',
    stages: [
      { duration: __ENV.SPIKE_RAMP_DURATION || '5s', target: Number(__ENV.SPIKE_RATE || 25) },
      { duration: duration, target: Number(__ENV.SPIKE_RATE || 25) },
      { duration: __ENV.SPIKE_RAMP_DOWN_DURATION || '5s', target: 1 },
    ],
    preAllocatedVUs: Math.min(actorLimit, Number(__ENV.PREALLOCATED_VUS || 10)),
    maxVUs: Math.min(actorLimit, Number(__ENV.MAX_VUS || actorLimit)),
  },
  soak: {
    executor: 'constant-vus',
    exec: 'soak',
    vus: Math.min(actorLimit, Number(__ENV.VUS || 5)),
    duration: __ENV.DURATION || '15m',
  },
};

if (!definitions[selectedScenario]) {
  throw new Error(`unknown SCENARIO: ${selectedScenario}`);
}

export const options = {
  scenarios: { [selectedScenario]: definitions[selectedScenario] },
  thresholds: {
    checks: ['rate>0.99'],
    chat_successful_iterations: ['rate>0.99'],
    chat_protocol_errors: ['count==0'],
    chat_delivery_misses: ['count==0'],
    chat_duplicate_deliveries: ['count==0'],
    ws_connecting: ['p(95)<1000'],
    chat_broadcast_latency: ['p(95)<1000'],
  },
};

export function connections() {
  connectionIteration(manifest, Number(__ENV.HOLD_MS || 1000));
}

export function messageWrite() {
  messageIteration(manifest, { ciphertextBytes: Number(__ENV.CIPHERTEXT_BYTES || 256) });
}

export function fanout() {
  messageIteration(manifest, { duplicateWindowMs: Number(__ENV.FANOUT_WINDOW_MS || 250) });
}

export function mixed() {
  if ((__ITER + __VU) % 4 === 0) {
    connectionIteration(manifest, Number(__ENV.HOLD_MS || 500));
    return;
  }
  messageIteration(manifest, { ciphertextBytes: Number(__ENV.CIPHERTEXT_BYTES || 256) });
}

export function spike() {
  messageIteration(manifest, { ciphertextBytes: Number(__ENV.CIPHERTEXT_BYTES || 256) });
}

export function soak() {
  messageIteration(manifest, { ciphertextBytes: Number(__ENV.CIPHERTEXT_BYTES || 256) });
}

export function seed() {
  messageIteration(manifest, { ciphertextBytes: Number(__ENV.CIPHERTEXT_BYTES || 256) });
}