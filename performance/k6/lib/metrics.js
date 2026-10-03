import { Counter, Rate, Trend } from 'k6/metrics';

export const mutationLatency = new Trend('chat_mutation_latency', true);
export const broadcastLatency = new Trend('chat_broadcast_latency', true);
export const protocolErrors = new Counter('chat_protocol_errors');
export const deliveryMisses = new Counter('chat_delivery_misses');
export const duplicateDeliveries = new Counter('chat_duplicate_deliveries');
export const successfulIterations = new Rate('chat_successful_iterations');