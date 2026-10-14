import { addItem, createBatch, markFlushed } from "./batch.js";

export function planFlushes(items, options) {
  if (!Array.isArray(items)) {
    throw new TypeError("items must be an array");
  }

  let state = createBatch(options);
  const batches = [];
  let start = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = readPlanItem(items[index], index);
    if (state.count > 0 && item.atMs < state.lastItemAtMs) {
      throw new RangeError(`items[${index}].atMs must be at or after the previous item`);
    }

    const step = addItem(state, { bytes: item.bytes, nowMs: item.atMs });
    if (step.closedBatch != null) {
      batches.push(recordedBatch(start, index, step.closedBatch));
      start = index;
    }

    state = step.state;
    if (step.decision.flush) {
      batches.push(
        recordedBatch(start, index + 1, {
          count: state.count,
          bytes: state.bytes,
          reason: step.decision.reason,
          openedAtMs: state.openedAtMs,
          closedAtMs: item.atMs
        })
      );
      state = markFlushed(state, item.atMs);
      start = index + 1;
    }
  }

  if (state.count === 0) {
    return Object.freeze({
      batches: Object.freeze(batches),
      pending: null
    });
  }

  return Object.freeze({
    batches: Object.freeze(batches),
    pending: Object.freeze({
      start,
      end: items.length,
      state
    })
  });
}

function readPlanItem(item, index) {
  if (item == null || typeof item !== "object" || Array.isArray(item)) {
    throw new TypeError(`items[${index}] must be an object`);
  }
  if (typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes)) {
    throw new TypeError(`items[${index}].bytes must be an integer`);
  }
  if (item.bytes < 0) {
    throw new RangeError(`items[${index}].bytes must be zero or greater`);
  }
  if (typeof item.atMs !== "number" || !Number.isFinite(item.atMs)) {
    throw new TypeError(`items[${index}].atMs must be a finite number`);
  }
  return {
    bytes: item.bytes,
    atMs: item.atMs
  };
}

function recordedBatch(start, end, closed) {
  return Object.freeze({
    start,
    end,
    count: closed.count,
    bytes: closed.bytes,
    reason: closed.reason,
    openedAtMs: closed.openedAtMs,
    closedAtMs: closed.closedAtMs
  });
}
