import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ITEMS,
  FlushReason,
  addItem,
  checkFlush,
  createBatch,
  markFlushed,
  planFlushes
} from "../src/index.js";

const mixedOptions = {
  maxItems: 3,
  maxBytes: 100,
  maxAgeMs: 1000,
  idleMs: 250
};

function replay(items, options) {
  let state = createBatch(options);
  const batches = [];
  let buffer = [];
  let start = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const step = addItem(state, { bytes: item.bytes, nowMs: item.atMs });
    if (step.closedBatch != null) {
      batches.push(recorded(start, index, buffer, step.closedBatch));
      buffer = [];
      start = index;
    }
    buffer.push(item.bytes);
    state = step.state;
    if (step.decision.flush) {
      batches.push(
        recorded(start, index + 1, buffer, {
          reason: step.decision.reason,
          openedAtMs: state.openedAtMs,
          closedAtMs: item.atMs
        })
      );
      buffer = [];
      state = markFlushed(state, item.atMs);
      start = index + 1;
    }
  }
  return {
    batches,
    pendingCount: buffer.length,
    state
  };
}

function recorded(start, end, buffer, closed) {
  let bytes = 0;
  for (const value of buffer) {
    bytes += value;
  }
  return {
    start,
    end,
    count: buffer.length,
    bytes,
    reason: closed.reason,
    openedAtMs: closed.openedAtMs,
    closedAtMs: closed.closedAtMs
  };
}

function assertPartition(items, plan, maxBytes) {
  const seen = new Array(items.length).fill(false);
  let cursor = 0;
  for (const batch of plan.batches) {
    assert.equal(batch.start, cursor);
    assert.ok(batch.end > batch.start);
    assert.equal(batch.count, batch.end - batch.start);
    let bytes = 0;
    for (let index = batch.start; index < batch.end; index += 1) {
      assert.equal(seen[index], false);
      seen[index] = true;
      bytes += items[index].bytes;
    }
    assert.equal(batch.bytes, bytes);
    assert.equal(batch.openedAtMs, items[batch.start].atMs);
    if (batch.reason === FlushReason.Oversize) {
      assert.equal(batch.count, 1);
      assert.ok(items[batch.start].bytes > maxBytes);
    } else {
      for (let index = batch.start; index < batch.end; index += 1) {
        assert.ok(items[index].bytes <= maxBytes);
      }
    }
    if (batch.end - batch.start > 1) {
      let prefix = 0;
      for (let index = batch.start; index < batch.end - 1; index += 1) {
        prefix += items[index].bytes;
      }
      assert.ok(prefix < maxBytes);
    }
    cursor = batch.end;
  }
  if (plan.pending != null) {
    assert.equal(plan.pending.start, cursor);
    assert.equal(plan.pending.end, items.length);
    assert.equal(plan.pending.state.count, items.length - cursor);
    for (let index = plan.pending.start; index < plan.pending.end; index += 1) {
      assert.equal(seen[index], false);
      seen[index] = true;
    }
    cursor = items.length;
  }
  assert.equal(cursor, items.length);
  assert.equal(
    seen.every((value) => value),
    true
  );
}

test("an empty list has no batches and nothing pending", () => {
  assert.deepEqual(planFlushes([]), {
    batches: [],
    pending: null
  });
  assert.deepEqual(planFlushes([], {}), planFlushes([]));
});

test("items under every limit stay pending and remember the defaults", () => {
  const plan = planFlushes([{ bytes: 20, atMs: 0 }]);
  assert.deepEqual(plan.batches, []);
  assert.equal(plan.pending.start, 0);
  assert.equal(plan.pending.end, 1);
  assert.equal(plan.pending.state.count, 1);
  assert.equal(plan.pending.state.bytes, 20);
  assert.equal(plan.pending.state.maxItems, DEFAULT_MAX_ITEMS);
  assert.equal(plan.pending.state.maxBytes, DEFAULT_MAX_BYTES);
  assert.equal(checkFlush(plan.pending.state, 0).nextCheckMs, 1000);
  assert.equal(checkFlush(plan.pending.state, 1000).reason, FlushReason.Idle);
});

test("the usage list closes the idle batch and leaves the later item pending", () => {
  const plan = planFlushes(
    [
      { bytes: 40, atMs: 0 },
      { bytes: 40, atMs: 100 },
      { bytes: 10, atMs: 1000 }
    ],
    mixedOptions
  );
  assert.deepEqual(plan.batches, [
    {
      start: 0,
      end: 2,
      count: 2,
      bytes: 80,
      reason: FlushReason.Idle,
      openedAtMs: 0,
      closedAtMs: 350
    }
  ]);
  assert.equal(plan.pending.start, 2);
  assert.equal(plan.pending.end, 3);
  assert.equal(plan.pending.state.count, 1);
  assert.equal(plan.pending.state.bytes, 10);
  assert.equal(plan.pending.state.openedAtMs, 1000);
  assert.equal(checkFlush(plan.pending.state, 1000).nextCheckMs, 1250);
});

test("a mixed list partitions count, bytes, idle, and oversize without dropping an item", () => {
  const items = [
    { bytes: 40, atMs: 0 },
    { bytes: 40, atMs: 100 },
    { bytes: 10, atMs: 1000 },
    { bytes: 200, atMs: 1000 },
    { bytes: 30, atMs: 1100 },
    { bytes: 30, atMs: 1200 },
    { bytes: 30, atMs: 1300 },
    { bytes: 10, atMs: 5000 }
  ];
  const plan = planFlushes(items, mixedOptions);
  assert.deepEqual(plan.batches, [
    {
      start: 0,
      end: 2,
      count: 2,
      bytes: 80,
      reason: FlushReason.Idle,
      openedAtMs: 0,
      closedAtMs: 350
    },
    {
      start: 2,
      end: 3,
      count: 1,
      bytes: 10,
      reason: FlushReason.Bytes,
      openedAtMs: 1000,
      closedAtMs: 1000
    },
    {
      start: 3,
      end: 4,
      count: 1,
      bytes: 200,
      reason: FlushReason.Oversize,
      openedAtMs: 1000,
      closedAtMs: 1000
    },
    {
      start: 4,
      end: 7,
      count: 3,
      bytes: 90,
      reason: FlushReason.Count,
      openedAtMs: 1100,
      closedAtMs: 1300
    }
  ]);
  assert.equal(plan.pending.state.count, 1);
  assert.equal(plan.pending.state.bytes, 10);
  assert.equal(plan.pending.start, 7);
  assert.equal(checkFlush(plan.pending.state, 5000).nextCheckMs, 5250);
  assertPartition(items, plan, mixedOptions.maxBytes);
  assert.deepEqual(replay(items, mixedOptions).batches, plan.batches);
});

test("an oversize item is its own batch between smaller items", () => {
  const items = [
    { bytes: 10, atMs: 0 },
    { bytes: 500, atMs: 10 },
    { bytes: 10, atMs: 20 }
  ];
  const options = { maxItems: 10, maxBytes: 100, maxAgeMs: 100000, idleMs: 100000 };
  const plan = planFlushes(items, options);
  assert.deepEqual(
    plan.batches.map((batch) => batch.reason),
    [FlushReason.Bytes, FlushReason.Oversize]
  );
  assert.deepEqual(
    plan.batches.map((batch) => [batch.start, batch.end, batch.bytes]),
    [
      [0, 1, 10],
      [1, 2, 500]
    ]
  );
  assert.equal(plan.pending.state.bytes, 10);
  assert.equal(plan.pending.start, 2);
  assertPartition(items, plan, options.maxBytes);
});

test("a leading oversize item flushes on its own", () => {
  const plan = planFlushes([{ bytes: 200, atMs: 0 }], {
    maxItems: 10,
    maxBytes: 100,
    maxAgeMs: 1000,
    idleMs: 1000
  });
  assert.equal(plan.pending, null);
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.batches[0].reason, FlushReason.Oversize);
  assert.equal(plan.batches[0].count, 1);
  assert.equal(plan.batches[0].closedAtMs, 0);
});

test("an item of exactly maxBytes is bytes, and one byte more is oversize", () => {
  const exact = planFlushes([{ bytes: 100, atMs: 5 }], {
    maxBytes: 100,
    maxItems: 10,
    maxAgeMs: 1000,
    idleMs: 1000
  });
  assert.equal(exact.batches[0].reason, FlushReason.Bytes);
  const over = planFlushes([{ bytes: 101, atMs: 5 }], {
    maxBytes: 100,
    maxItems: 10,
    maxAgeMs: 1000,
    idleMs: 1000
  });
  assert.equal(over.batches[0].reason, FlushReason.Oversize);
});

test("maxItems wins when the only item is also oversize", () => {
  const plan = planFlushes([{ bytes: 500, atMs: 0 }], {
    maxItems: 1,
    maxBytes: 100,
    maxAgeMs: 0,
    idleMs: 0
  });
  assert.equal(plan.batches[0].reason, FlushReason.Count);
  assert.equal(plan.pending, null);
});

test("age closes at the deadline and does not take a later item", () => {
  const items = [
    { bytes: 5, atMs: 0 },
    { bytes: 7, atMs: 500 }
  ];
  const options = { maxItems: 10, maxBytes: 1000, maxAgeMs: 100, idleMs: 10000 };
  const plan = planFlushes(items, options);
  assert.deepEqual(plan.batches, [
    {
      start: 0,
      end: 1,
      count: 1,
      bytes: 5,
      reason: FlushReason.Age,
      openedAtMs: 0,
      closedAtMs: 100
    }
  ]);
  assert.equal(plan.pending.state.bytes, 7);
  assert.equal(plan.pending.state.openedAtMs, 500);
});

test("an item that arrives exactly at the age deadline starts the next batch", () => {
  const plan = planFlushes(
    [
      { bytes: 10, atMs: 0 },
      { bytes: 10, atMs: 100 }
    ],
    { maxItems: 10, maxBytes: 1000, maxAgeMs: 100, idleMs: 10000 }
  );
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.batches[0].reason, FlushReason.Age);
  assert.equal(plan.batches[0].end, 1);
  assert.equal(plan.batches[0].closedAtMs, 100);
  assert.equal(plan.pending.start, 1);
  assert.equal(plan.pending.state.count, 1);
});

test("an item one millisecond before the age deadline stays in the open batch", () => {
  const plan = planFlushes(
    [
      { bytes: 10, atMs: 0 },
      { bytes: 10, atMs: 99 }
    ],
    { maxItems: 10, maxBytes: 1000, maxAgeMs: 100, idleMs: 10000 }
  );
  assert.deepEqual(plan.batches, []);
  assert.equal(plan.pending.state.count, 2);
  assert.equal(plan.pending.state.openedAtMs, 0);
  assert.equal(checkFlush(plan.pending.state, 99).nextCheckMs, 100);
});

test("a tie between age and idle closes with age", () => {
  const plan = planFlushes(
    [
      { bytes: 1, atMs: 0 },
      { bytes: 1, atMs: 150 }
    ],
    { maxItems: 10, maxBytes: 100, maxAgeMs: 100, idleMs: 100 }
  );
  assert.equal(plan.batches[0].reason, FlushReason.Age);
  assert.equal(plan.batches[0].closedAtMs, 100);
  assert.equal(plan.batches[0].end, 1);
});

test("an earlier idle deadline wins over a later age deadline", () => {
  const plan = planFlushes(
    [
      { bytes: 1, atMs: 0 },
      { bytes: 1, atMs: 500 }
    ],
    { maxItems: 10, maxBytes: 100, maxAgeMs: 1000, idleMs: 100 }
  );
  assert.equal(plan.batches[0].reason, FlushReason.Idle);
  assert.equal(plan.batches[0].closedAtMs, 100);
});

test("count wins over bytes for a pair that reaches both", () => {
  const plan = planFlushes(
    [
      { bytes: 40, atMs: 0 },
      { bytes: 40, atMs: 10 }
    ],
    { maxItems: 2, maxBytes: 50, maxAgeMs: 10000, idleMs: 10000 }
  );
  assert.equal(plan.pending, null);
  assert.equal(plan.batches[0].reason, FlushReason.Count);
  assert.equal(plan.batches[0].bytes, 80);
  assert.equal(plan.batches[0].closedAtMs, 10);
});

test("bytes flush the item that reached the limit and leave no pending tail", () => {
  const plan = planFlushes(
    [
      { bytes: 30, atMs: 0 },
      { bytes: 30, atMs: 50 }
    ],
    { maxItems: 10, maxBytes: 50, maxAgeMs: 1000, idleMs: 10000 }
  );
  assert.equal(plan.pending, null);
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.batches[0].reason, FlushReason.Bytes);
  assert.equal(plan.batches[0].bytes, 60);
  assert.equal(plan.batches[0].closedAtMs, 50);
  assert.ok(plan.batches[0].bytes > 50);
});

test("a zero idle span flushes every item on its own timestamp", () => {
  const items = [
    { bytes: 2, atMs: 0 },
    { bytes: 3, atMs: 0 },
    { bytes: 4, atMs: 5 }
  ];
  const plan = planFlushes(items, {
    maxItems: 10,
    maxBytes: 100,
    maxAgeMs: 5000,
    idleMs: 0
  });
  assert.equal(plan.pending, null);
  assert.deepEqual(
    plan.batches.map((batch) => [batch.reason, batch.closedAtMs, batch.bytes]),
    [
      [FlushReason.Idle, 0, 2],
      [FlushReason.Idle, 0, 3],
      [FlushReason.Idle, 5, 4]
    ]
  );
});

test("a zero age span wins over a zero idle span", () => {
  const plan = planFlushes(
    [
      { bytes: 2, atMs: 4 },
      { bytes: 2, atMs: 9 }
    ],
    { maxItems: 10, maxBytes: 100, maxAgeMs: 0, idleMs: 0 }
  );
  assert.deepEqual(
    plan.batches.map((batch) => batch.reason),
    [FlushReason.Age, FlushReason.Age]
  );
});

test("the caller loop and planFlushes name the same batches", () => {
  const items = [
    { bytes: 40, atMs: 0 },
    { bytes: 70, atMs: 10 },
    { bytes: 10, atMs: 20 },
    { bytes: 1000, atMs: 20 },
    { bytes: 1, atMs: 4000 }
  ];
  const options = { maxItems: 4, maxBytes: 100, maxAgeMs: 500, idleMs: 50 };
  const plan = planFlushes(items, options);
  const played = replay(items, options);
  assert.deepEqual(played.batches, plan.batches);
  assert.equal(played.pendingCount, plan.pending.state.count);
  assert.equal(played.state.bytes, plan.pending.state.bytes);
  assertPartition(items, plan, options.maxBytes);
});

test("planFlushes does not mutate the list", () => {
  const items = [
    { bytes: 1, atMs: 0, tag: "keep" },
    { bytes: 2, atMs: 10 }
  ];
  const copy = JSON.parse(JSON.stringify(items));
  const plan = planFlushes(items, { maxItems: 1, maxBytes: 100, maxAgeMs: 1000, idleMs: 1000 });
  assert.deepEqual(items, copy);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.batches), true);
  assert.equal(Object.isFrozen(plan.batches[0]), true);
  assert.equal(plan.batches[0].reason, FlushReason.Count);
});

test("planFlushes rejects a list, an entry, or a clock that cannot be replayed", () => {
  assert.throws(() => planFlushes(null), {
    name: "TypeError",
    message: "items must be an array"
  });
  assert.throws(() => planFlushes({}), TypeError);
  assert.throws(() => planFlushes([null]), {
    name: "TypeError",
    message: "items[0] must be an object"
  });
  assert.throws(() => planFlushes([[]]), TypeError);
  assert.throws(() => planFlushes([{ bytes: 1.5, atMs: 0 }]), {
    name: "TypeError",
    message: "items[0].bytes must be an integer"
  });
  assert.throws(() => planFlushes([{ bytes: -1, atMs: 0 }]), {
    name: "RangeError",
    message: "items[0].bytes must be zero or greater"
  });
  assert.throws(() => planFlushes([{ bytes: 1, atMs: Number.NaN }]), {
    name: "TypeError",
    message: "items[0].atMs must be a finite number"
  });
  assert.throws(
    () =>
      planFlushes([
        { bytes: 1, atMs: 10 },
        { bytes: 1, atMs: 9 }
      ]),
    {
      name: "RangeError",
      message: "items[1].atMs must be at or after the previous item"
    }
  );
  assert.throws(() => planFlushes([], null), {
    name: "TypeError",
    message: "options must be an object"
  });
  assert.throws(() => planFlushes([], { maxItems: 0 }), RangeError);
});
