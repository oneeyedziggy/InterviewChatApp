export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const parsePositiveTimestamp = (raw: unknown): number | undefined => {
  const numeric =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number.parseInt(raw, 10)
        : NaN;
  return Number.isFinite(numeric) && numeric > 0
    ? Math.trunc(numeric)
    : undefined;
};
