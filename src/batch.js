export const DEFAULT_MAX_ITEMS = 100;
export const DEFAULT_MAX_BYTES = 1048576;
export const DEFAULT_MAX_AGE_MS = 5000;
export const DEFAULT_IDLE_MS = 1000;

export const FlushReason = Object.freeze({
  Count: "count",
  Oversize: "oversize",
  Bytes: "bytes",
  Age: "age",
  Idle: "idle",
  None: "none"
});

export const FLUSH_REASONS = Object.freeze([
  FlushReason.Count,
  FlushReason.Oversize,
  FlushReason.Bytes,
  FlushReason.Age,
  FlushReason.Idle,
  FlushReason.None
]);

export function createBatch(options) {
  return emptyBatch(readOptions(options));
}

export function addItem(state, item) {
  const batch = readState(state);
  const entry = readEntry(item);
  assertClock(batch, entry.nowMs, "item.nowMs must be at or after the last item");

  const blocked = blockAdmission(batch, entry);
  if (blocked != null) {
    const admitted = admit(emptyBatch(limitsOf(batch)), entry);
    return Object.freeze({
      state: admitted,
      closedBatch: closeRecord(batch, blocked.reason, entry.nowMs),
      decision: decide(admitted, entry.nowMs)
    });
  }

  const admitted = admit(batch, entry);
  return Object.freeze({
    state: admitted,
    closedBatch: null,
    decision: decide(admitted, entry.nowMs)
  });
}

export function checkFlush(state, nowMs) {
  const batch = readState(state);
  const now = readNow(nowMs, "nowMs");
  assertClock(batch, now, "nowMs must be at or after the last item");
  return decide(batch, now);
}

export function markFlushed(state, nowMs) {
  const batch = readState(state);
  const now = readNow(nowMs, "nowMs");
  assertClock(batch, now, "nowMs must be at or after the last item");
  return emptyBatch(limitsOf(batch));
}

function readOptions(options) {
  if (options === undefined) {
    return defaultLimits();
  }
  if (options == null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  return {
    maxItems: readLimit(options.maxItems, DEFAULT_MAX_ITEMS, "maxItems"),
    maxBytes: readLimit(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes"),
    maxAgeMs: readSpan(options.maxAgeMs, DEFAULT_MAX_AGE_MS, "maxAgeMs"),
    idleMs: readSpan(options.idleMs, DEFAULT_IDLE_MS, "idleMs")
  };
}

function readLimit(value, fallback, name) {
  if (value === undefined) {
    return fallback;
  }
  return requireLimit(value, name);
}

function requireLimit(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be an integer`);
  }
  if (value < 1) {
    throw new RangeError(`${name} must be at least 1`);
  }
  return value;
}

function readSpan(value, fallback, name) {
  if (value === undefined) {
    return fallback;
  }
  return requireSpan(value, name);
}

function requireSpan(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  if (value < 0) {
    throw new RangeError(`${name} must be zero or greater`);
  }
  return value;
}

function defaultLimits() {
  return {
    maxItems: DEFAULT_MAX_ITEMS,
    maxBytes: DEFAULT_MAX_BYTES,
    maxAgeMs: DEFAULT_MAX_AGE_MS,
    idleMs: DEFAULT_IDLE_MS
  };
}

function readState(state) {
  if (state == null || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("state must be an object");
  }
  const limits = {
    maxItems: requireLimit(state.maxItems, "state.maxItems"),
    maxBytes: requireLimit(state.maxBytes, "state.maxBytes"),
    maxAgeMs: requireSpan(state.maxAgeMs, "state.maxAgeMs"),
    idleMs: requireSpan(state.idleMs, "state.idleMs")
  };
  const count = readCount(state.count);
  const bytes = readTotalBytes(state.bytes);
  if (count === 0) {
    if (bytes !== 0 || state.openedAtMs != null || state.lastItemAtMs != null) {
      throw new TypeError("an empty batch must have zero bytes and null timestamps");
    }
    return emptyBatch(limits);
  }
  if (count > limits.maxItems) {
    throw new RangeError("state.count exceeds maxItems");
  }
  const openedAtMs = readNow(state.openedAtMs, "state.openedAtMs");
  const lastItemAtMs = readNow(state.lastItemAtMs, "state.lastItemAtMs");
  if (lastItemAtMs < openedAtMs) {
    throw new RangeError("state.lastItemAtMs must be at or after openedAtMs");
  }
  return batchState({
    count,
    bytes,
    openedAtMs,
    lastItemAtMs,
    ...limits
  });
}

function readCount(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError("state.count must be an integer");
  }
  if (value < 0) {
    throw new RangeError("state.count must be zero or greater");
  }
  return value;
}

function readTotalBytes(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError("state.bytes must be an integer");
  }
  if (value < 0) {
    throw new RangeError("state.bytes must be zero or greater");
  }
  return value;
}

function readEntry(item) {
  if (item == null || typeof item !== "object" || Array.isArray(item)) {
    throw new TypeError("item must be an object");
  }
  if (typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes)) {
    throw new TypeError("item.bytes must be an integer");
  }
  if (item.bytes < 0) {
    throw new RangeError("item.bytes must be zero or greater");
  }
  return {
    bytes: item.bytes,
    nowMs: readNow(item.nowMs, "item.nowMs")
  };
}

function readNow(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

function assertClock(batch, nowMs, message) {
  if (batch.count > 0 && nowMs < batch.lastItemAtMs) {
    throw new RangeError(message);
  }
}

function blockAdmission(batch, entry) {
  if (batch.count === 0) {
    return null;
  }
  const open = decide(batch, entry.nowMs);
  if (open.flush) {
    return open;
  }
  if (entry.bytes > batch.maxBytes) {
    return decision(true, FlushReason.Bytes, null);
  }
  return null;
}

function admit(batch, entry) {
  const bytes = batch.bytes + entry.bytes;
  if (!Number.isSafeInteger(bytes)) {
    throw new RangeError("batch bytes exceed the safe integer range");
  }
  return batchState({
    count: batch.count + 1,
    bytes,
    openedAtMs: batch.count === 0 ? entry.nowMs : batch.openedAtMs,
    lastItemAtMs: entry.nowMs,
    ...limitsOf(batch)
  });
}

function decide(batch, nowMs) {
  if (batch.count === 0) {
    return decision(false, FlushReason.None, null);
  }
  if (batch.count >= batch.maxItems) {
    return decision(true, FlushReason.Count, null);
  }
  if (batch.count === 1 && batch.bytes > batch.maxBytes) {
    return decision(true, FlushReason.Oversize, null);
  }
  if (batch.bytes >= batch.maxBytes) {
    return decision(true, FlushReason.Bytes, null);
  }
  return timeDecision(batch, nowMs);
}

function timeDecision(batch, nowMs) {
  const ageAt = batch.openedAtMs + batch.maxAgeMs;
  const idleAt = batch.lastItemAtMs + batch.idleMs;
  if (nowMs < ageAt && nowMs < idleAt) {
    return decision(false, FlushReason.None, ageAt <= idleAt ? ageAt : idleAt);
  }
  if (ageAt <= nowMs && ageAt <= idleAt) {
    return decision(true, FlushReason.Age, null);
  }
  return decision(true, FlushReason.Idle, null);
}

function closeRecord(batch, reason, nowMs) {
  return Object.freeze({
    count: batch.count,
    bytes: batch.bytes,
    reason,
    openedAtMs: batch.openedAtMs,
    closedAtMs: closeTime(batch, reason, nowMs)
  });
}

function closeTime(batch, reason, nowMs) {
  if (reason === FlushReason.Age) {
    return batch.openedAtMs + batch.maxAgeMs;
  }
  if (reason === FlushReason.Idle) {
    return batch.lastItemAtMs + batch.idleMs;
  }
  return nowMs;
}

function emptyBatch(limits) {
  return batchState({
    count: 0,
    bytes: 0,
    openedAtMs: null,
    lastItemAtMs: null,
    maxItems: limits.maxItems,
    maxBytes: limits.maxBytes,
    maxAgeMs: limits.maxAgeMs,
    idleMs: limits.idleMs
  });
}

function limitsOf(batch) {
  return {
    maxItems: batch.maxItems,
    maxBytes: batch.maxBytes,
    maxAgeMs: batch.maxAgeMs,
    idleMs: batch.idleMs
  };
}

function batchState(fields) {
  return Object.freeze({
    count: fields.count,
    bytes: fields.bytes,
    openedAtMs: fields.openedAtMs,
    lastItemAtMs: fields.lastItemAtMs,
    maxItems: fields.maxItems,
    maxBytes: fields.maxBytes,
    maxAgeMs: fields.maxAgeMs,
    idleMs: fields.idleMs
  });
}

function decision(flush, reason, nextCheckMs) {
  return Object.freeze({
    flush,
    reason,
    nextCheckMs
  });
}
