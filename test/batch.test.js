import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_IDLE_MS,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ITEMS,
  FLUSH_REASONS,
  FlushReason,
  addItem,
  checkFlush,
  createBatch,
  markFlushed
} from "../src/index.js";

const limits = {
  maxItems: 10,
  maxBytes: 100,
  maxAgeMs: 1000,
  idleMs: 250
};

function openBatch(overrides) {
  return createBatch({ ...limits, ...overrides });
}

function taken(state, bytes, nowMs) {
  return addItem(state, { bytes, nowMs });
}

test("createBatch starts empty and uses the named defaults", () => {
  assert.equal(DEFAULT_MAX_ITEMS, 100);
  assert.equal(DEFAULT_MAX_BYTES, 1048576);
  assert.equal(DEFAULT_MAX_AGE_MS, 5000);
  assert.equal(DEFAULT_IDLE_MS, 1000);
  assert.deepEqual(createBatch(), {
    count: 0,
    bytes: 0,
    openedAtMs: null,
    lastItemAtMs: null,
    maxItems: DEFAULT_MAX_ITEMS,
    maxBytes: DEFAULT_MAX_BYTES,
    maxAgeMs: DEFAULT_MAX_AGE_MS,
    idleMs: DEFAULT_IDLE_MS
  });
  assert.deepEqual(createBatch(undefined), createBatch());
  assert.deepEqual(createBatch({}), createBatch());
});

test("omitted options keep their defaults and unknown fields are ignored", () => {
  const options = { maxItems: 4, label: "ignored" };
  const state = createBatch(options);
  options.maxItems = 1;
  assert.equal(state.maxItems, 4);
  assert.equal(state.maxBytes, DEFAULT_MAX_BYTES);
  assert.equal(state.maxAgeMs, DEFAULT_MAX_AGE_MS);
  assert.equal(state.idleMs, DEFAULT_IDLE_MS);
  assert.equal(Object.hasOwn(state, "label"), false);
  assert.equal(createBatch({ maxAgeMs: 0, idleMs: 0 }).maxAgeMs, 0);
  assert.equal(createBatch({ idleMs: 0 }).idleMs, 0);
});

test("createBatch rejects a limit that is not a usable number", () => {
  assert.throws(() => createBatch(null), {
    name: "TypeError",
    message: "options must be an object"
  });
  assert.throws(() => createBatch([]), TypeError);
  assert.throws(() => createBatch("batch"), TypeError);
  assert.throws(() => createBatch({ maxItems: null }), TypeError);
  assert.throws(() => createBatch({ maxBytes: null }), TypeError);
  assert.throws(() => createBatch({ maxItems: 1.5 }), {
    name: "TypeError",
    message: "maxItems must be an integer"
  });
  assert.throws(() => createBatch({ maxItems: Number.NaN }), TypeError);
  assert.throws(() => createBatch({ maxItems: Number.POSITIVE_INFINITY }), TypeError);
  assert.throws(() => createBatch({ maxItems: "2" }), TypeError);
  assert.throws(() => createBatch({ maxBytes: 1.2 }), TypeError);
  assert.throws(() => createBatch({ maxAgeMs: Number.NaN }), {
    name: "TypeError",
    message: "maxAgeMs must be a finite number"
  });
  assert.throws(() => createBatch({ maxAgeMs: Number.POSITIVE_INFINITY }), TypeError);
  assert.throws(() => createBatch({ idleMs: "0" }), TypeError);
  assert.throws(() => createBatch({ maxItems: 0 }), {
    name: "RangeError",
    message: "maxItems must be at least 1"
  });
  assert.throws(() => createBatch({ maxItems: -3 }), RangeError);
  assert.throws(() => createBatch({ maxBytes: 0 }), {
    name: "RangeError",
    message: "maxBytes must be at least 1"
  });
  assert.throws(() => createBatch({ maxAgeMs: -1 }), {
    name: "RangeError",
    message: "maxAgeMs must be zero or greater"
  });
  assert.throws(() => createBatch({ idleMs: -0.1 }), RangeError);
});

test("an empty batch never flushes", () => {
  const state = openBatch();
  assert.deepEqual(checkFlush(state, 0), {
    flush: false,
    reason: FlushReason.None,
    nextCheckMs: null
  });
  assert.deepEqual(checkFlush(state, 99999), {
    flush: false,
    reason: FlushReason.None,
    nextCheckMs: null
  });
  assert.deepEqual(checkFlush(markFlushed(state, -5), 40), {
    flush: false,
    reason: FlushReason.None,
    nextCheckMs: null
  });
});

test("the first item arms the earlier of the age and idle deadlines", () => {
  const step = taken(openBatch(), 40, 0);
  assert.equal(step.closedBatch, null);
  assert.equal(step.decision.flush, false);
  assert.equal(step.decision.reason, FlushReason.None);
  assert.equal(step.decision.nextCheckMs, 250);
  assert.equal(step.state.count, 1);
  assert.equal(step.state.bytes, 40);
  assert.equal(step.state.openedAtMs, 0);
  assert.equal(step.state.lastItemAtMs, 0);
  assert.equal(checkFlush(step.state, 249).flush, false);
  assert.equal(checkFlush(step.state, 249).nextCheckMs, 250);
  assert.deepEqual(checkFlush(step.state, 250), {
    flush: true,
    reason: FlushReason.Idle,
    nextCheckMs: null
  });
});

test("a later item keeps the oldest timestamp and moves the idle deadline", () => {
  const first = taken(openBatch(), 40, 0);
  const second = taken(first.state, 30, 100);
  assert.equal(second.closedBatch, null);
  assert.equal(second.decision.flush, false);
  assert.equal(second.decision.nextCheckMs, 350);
  assert.equal(second.state.count, 2);
  assert.equal(second.state.bytes, 70);
  assert.equal(second.state.openedAtMs, 0);
  assert.equal(second.state.lastItemAtMs, 100);
  assert.equal(first.state.count, 1);
  assert.equal(first.state.lastItemAtMs, 0);
});

test("item count flushes at maxItems and not before", () => {
  const state = openBatch({ maxItems: 3, maxBytes: 1000, maxAgeMs: 10000, idleMs: 10000 });
  const first = taken(state, 1, 0);
  const second = taken(first.state, 1, 1);
  const third = taken(second.state, 1, 2);
  assert.equal(second.decision.flush, false);
  assert.equal(third.closedBatch, null);
  assert.deepEqual(third.decision, {
    flush: true,
    reason: FlushReason.Count,
    nextCheckMs: null
  });
  assert.equal(third.state.count, 3);
  assert.equal(checkFlush(third.state, 2).reason, FlushReason.Count);
});

test("total bytes flush when they reach maxBytes, including a total that passes it", () => {
  const state = openBatch({ maxItems: 10, maxBytes: 100, maxAgeMs: 10000, idleMs: 10000 });
  const under = taken(state, 60, 0);
  assert.equal(under.decision.flush, false);
  const exact = taken(openBatch({ maxBytes: 100, maxAgeMs: 10000, idleMs: 10000 }), 100, 0);
  assert.equal(exact.decision.reason, FlushReason.Bytes);
  assert.equal(exact.state.bytes, 100);
  const passed = taken(under.state, 50, 10);
  assert.equal(passed.closedBatch, null);
  assert.equal(passed.decision.reason, FlushReason.Bytes);
  assert.equal(passed.state.count, 2);
  assert.equal(passed.state.bytes, 110);
  assert.ok(passed.state.bytes > passed.state.maxBytes);
  assert.ok(50 <= passed.state.maxBytes);
});

test("one item that exceeds maxBytes flushes alone with reason oversize", () => {
  const step = taken(openBatch({ maxBytes: 100 }), 101, 0);
  assert.equal(step.closedBatch, null);
  assert.deepEqual(step.decision, {
    flush: true,
    reason: FlushReason.Oversize,
    nextCheckMs: null
  });
  assert.equal(step.state.count, 1);
  assert.equal(step.state.bytes, 101);
  const exact = taken(openBatch({ maxBytes: 100, maxAgeMs: 0, idleMs: 0 }), 100, 0);
  assert.equal(exact.decision.reason, FlushReason.Bytes);
});

test("an oversize item does not join a non-empty batch and is not dropped", () => {
  const open = taken(openBatch({ maxBytes: 100, maxAgeMs: 10000, idleMs: 10000 }), 40, 0);
  const step = taken(open.state, 150, 25);
  assert.deepEqual(step.closedBatch, {
    count: 1,
    bytes: 40,
    reason: FlushReason.Bytes,
    openedAtMs: 0,
    closedAtMs: 25
  });
  assert.equal(step.state.count, 1);
  assert.equal(step.state.bytes, 150);
  assert.equal(step.state.openedAtMs, 25);
  assert.equal(step.decision.reason, FlushReason.Oversize);
  assert.equal(open.state.count, 1);
  assert.equal(open.state.bytes, 40);
});

test("age flushes when the oldest item reaches maxAgeMs", () => {
  const step = taken(openBatch({ maxAgeMs: 1000, idleMs: 10000 }), 5, 0);
  assert.equal(checkFlush(step.state, 999).flush, false);
  assert.equal(checkFlush(step.state, 999).nextCheckMs, 1000);
  assert.deepEqual(checkFlush(step.state, 1000), {
    flush: true,
    reason: FlushReason.Age,
    nextCheckMs: null
  });
  assert.equal(checkFlush(step.state, 5000).reason, FlushReason.Age);
});

test("a fractional age deadline uses the sum of the opened time and maxAgeMs", () => {
  const step = taken(openBatch({ maxAgeMs: 1.5, idleMs: 10 }), 1, 0.25);
  assert.equal(step.decision.nextCheckMs, 1.75);
  assert.equal(checkFlush(step.state, 1.749).flush, false);
  assert.equal(checkFlush(step.state, 1.75).reason, FlushReason.Age);
});

test("idle flushes a non-empty batch once the gap since the last item reaches idleMs", () => {
  const first = taken(openBatch({ idleMs: 250, maxAgeMs: 10000 }), 5, 0);
  const second = taken(first.state, 5, 100);
  assert.equal(second.decision.nextCheckMs, 350);
  assert.equal(checkFlush(second.state, 349).reason, FlushReason.None);
  assert.equal(checkFlush(second.state, 350).reason, FlushReason.Idle);
  const cleared = markFlushed(second.state, 350);
  assert.equal(checkFlush(cleared, 350).flush, false);
  assert.equal(checkFlush(cleared, 100000).flush, false);
});

test("a late check keeps the earlier time rule when both age and idle have elapsed", () => {
  const idleFirst = taken(openBatch({ maxAgeMs: 1000, idleMs: 100 }), 5, 0);
  assert.equal(checkFlush(idleFirst.state, 5000).reason, FlushReason.Idle);
  const ageFirst = taken(openBatch({ maxAgeMs: 100, idleMs: 1000 }), 5, 0);
  assert.equal(checkFlush(ageFirst.state, 5000).reason, FlushReason.Age);
  const tie = taken(openBatch({ maxAgeMs: 100, idleMs: 100 }), 5, 0);
  assert.equal(checkFlush(tie.state, 100).reason, FlushReason.Age);
  assert.equal(checkFlush(tie.state, 99).flush, false);
});

test("count wins over bytes, oversize, age, and idle", () => {
  const state = taken(
    openBatch({ maxItems: 1, maxBytes: 10, maxAgeMs: 0, idleMs: 0 }),
    50,
    0
  ).state;
  assert.equal(checkFlush(state, 0).reason, FlushReason.Count);
  assert.equal(checkFlush(state, 1000).reason, FlushReason.Count);
});

test("oversize wins over bytes, age, and idle when the item is alone", () => {
  const step = taken(openBatch({ maxItems: 10, maxBytes: 10, maxAgeMs: 0, idleMs: 0 }), 11, 0);
  assert.equal(step.decision.reason, FlushReason.Oversize);
});

test("bytes win over age and idle", () => {
  const step = taken(openBatch({ maxItems: 10, maxBytes: 10, maxAgeMs: 0, idleMs: 0 }), 10, 0);
  assert.equal(step.decision.reason, FlushReason.Bytes);
});

test("count wins over bytes when the same item reaches both limits", () => {
  const state = openBatch({ maxItems: 2, maxBytes: 10, maxAgeMs: 10000, idleMs: 10000 });
  const second = taken(taken(state, 6, 0).state, 6, 10);
  assert.equal(second.closedBatch, null);
  assert.equal(second.decision.reason, FlushReason.Count);
  assert.equal(second.state.bytes, 12);
});

test("an item that arrives after a deadline does not join the closed batch", () => {
  const open = taken(openBatch({ maxAgeMs: 1000, idleMs: 100, maxBytes: 1000 }), 5, 0);
  const step = taken(open.state, 7, 5000);
  assert.deepEqual(step.closedBatch, {
    count: 1,
    bytes: 5,
    reason: FlushReason.Idle,
    openedAtMs: 0,
    closedAtMs: 100
  });
  assert.equal(step.state.count, 1);
  assert.equal(step.state.bytes, 7);
  assert.equal(step.state.openedAtMs, 5000);
  assert.equal(step.decision.flush, false);
  assert.equal(step.decision.nextCheckMs, 5100);
});

test("age closes the open batch when it is due at the same time as the next item", () => {
  const open = taken(openBatch({ maxAgeMs: 100, idleMs: 10000 }), 5, 0);
  const step = taken(open.state, 9, 100);
  assert.equal(step.closedBatch.reason, FlushReason.Age);
  assert.equal(step.closedBatch.closedAtMs, 100);
  assert.equal(step.closedBatch.count, 1);
  assert.equal(step.state.count, 1);
  assert.equal(step.state.openedAtMs, 100);
  assert.equal(step.decision.flush, false);
});

test("a zero maxAgeMs flushes on admission unless a higher rule already matched", () => {
  const aged = taken(openBatch({ maxAgeMs: 0, idleMs: 5000, maxItems: 10, maxBytes: 1000 }), 4, 20);
  assert.equal(aged.decision.reason, FlushReason.Age);
  assert.equal(aged.decision.nextCheckMs, null);
  const counted = taken(openBatch({ maxItems: 1, maxAgeMs: 0, idleMs: 0 }), 4, 20);
  assert.equal(counted.decision.reason, FlushReason.Count);
});

test("a zero idleMs flushes on admission when age has not been reached", () => {
  const step = taken(openBatch({ maxAgeMs: 5000, idleMs: 0, maxItems: 10, maxBytes: 1000 }), 4, 20);
  assert.equal(step.decision.reason, FlushReason.Idle);
  const both = taken(openBatch({ maxAgeMs: 0, idleMs: 0 }), 4, 20);
  assert.equal(both.decision.reason, FlushReason.Age);
});

test("zero-byte items count toward maxItems and do not reach maxBytes", () => {
  const state = openBatch({ maxItems: 2, maxBytes: 100, maxAgeMs: 10000, idleMs: 10000 });
  const second = taken(taken(state, 0, 0).state, 0, 1);
  assert.equal(second.decision.reason, FlushReason.Count);
  assert.equal(second.state.bytes, 0);
});

test("equal timestamps are allowed", () => {
  const state = openBatch({ maxAgeMs: 1000, idleMs: 1000 });
  const second = taken(taken(state, 1, 5).state, 1, 5);
  assert.equal(second.closedBatch, null);
  assert.equal(second.decision.flush, false);
  assert.equal(second.state.count, 2);
  assert.equal(second.state.lastItemAtMs, 5);
});

test("ignoring a flush seals that batch before the next item is admitted", () => {
  const due = taken(openBatch({ maxItems: 1 }), 4, 0);
  assert.equal(due.decision.reason, FlushReason.Count);
  const next = taken(due.state, 6, 30);
  assert.equal(next.closedBatch.reason, FlushReason.Count);
  assert.equal(next.closedBatch.count, 1);
  assert.equal(next.closedBatch.bytes, 4);
  assert.equal(next.state.count, 1);
  assert.equal(next.state.bytes, 6);
  assert.equal(next.state.openedAtMs, 30);
});

test("markFlushed resets the counters and keeps the limits", () => {
  const custom = openBatch({ maxItems: 4, maxBytes: 9, maxAgeMs: 8, idleMs: 7 });
  const filled = taken(custom, 3, 10).state;
  const cleared = markFlushed(filled, 15);
  assert.notEqual(cleared, filled);
  assert.equal(filled.count, 1);
  assert.deepEqual(cleared, {
    count: 0,
    bytes: 0,
    openedAtMs: null,
    lastItemAtMs: null,
    maxItems: 4,
    maxBytes: 9,
    maxAgeMs: 8,
    idleMs: 7
  });
  const again = markFlushed(cleared, 16);
  assert.deepEqual(again, cleared);
  assert.notEqual(again, cleared);
});

test("returned states and decisions are frozen and inputs are not mutated", () => {
  const state = openBatch();
  const item = { bytes: 10, nowMs: 0, note: "keep" };
  const step = taken(state, item.bytes, item.nowMs);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(step), true);
  assert.equal(Object.isFrozen(step.state), true);
  assert.equal(Object.isFrozen(step.decision), true);
  assert.throws(() => {
    state.count = 4;
  }, TypeError);
  assert.deepEqual(item, { bytes: 10, nowMs: 0, note: "keep" });
  assert.equal(state.count, 0);
  const again = taken(state, 2, 5);
  assert.equal(step.state.count, 1);
  assert.equal(again.state.count, 1);
  assert.notEqual(step.state, again.state);
});

test("a state can be copied through JSON and used again", () => {
  const filled = taken(openBatch(), 15, 10).state;
  const restored = JSON.parse(JSON.stringify(filled));
  const step = taken(restored, 5, 12);
  assert.equal(step.state.count, 2);
  assert.equal(step.state.bytes, 20);
  assert.equal(step.state.openedAtMs, 10);
});

test("the clock cannot move backwards", () => {
  const state = taken(openBatch(), 1, 50).state;
  assert.throws(() => taken(state, 1, 49), {
    name: "RangeError",
    message: "item.nowMs must be at or after the last item"
  });
  assert.throws(() => checkFlush(state, 49), {
    name: "RangeError",
    message: "nowMs must be at or after the last item"
  });
  assert.throws(() => markFlushed(state, 49), RangeError);
  assert.equal(taken(state, 1, 50).state.count, 2);
});

test("addItem and checkFlush reject a bad item, clock, or state", () => {
  const state = openBatch();
  assert.throws(() => taken(null, 1, 0), {
    name: "TypeError",
    message: "state must be an object"
  });
  assert.throws(() => checkFlush([], 0), TypeError);
  assert.throws(() => checkFlush(state, "0"), {
    name: "TypeError",
    message: "nowMs must be a finite number"
  });
  assert.throws(() => checkFlush(state, Number.NaN), TypeError);
  assert.throws(() => addItem(state, null), {
    name: "TypeError",
    message: "item must be an object"
  });
  assert.throws(() => addItem(state, []), TypeError);
  assert.throws(() => addItem(state, { bytes: -1, nowMs: 0 }), {
    name: "RangeError",
    message: "item.bytes must be zero or greater"
  });
  assert.throws(() => addItem(state, { bytes: 1.2, nowMs: 0 }), {
    name: "TypeError",
    message: "item.bytes must be an integer"
  });
  assert.throws(() => addItem(state, { bytes: 1 }), {
    name: "TypeError",
    message: "item.nowMs must be a finite number"
  });
  assert.throws(() => addItem(state, { nowMs: 0 }), TypeError);
  assert.throws(() => checkFlush({ ...state, bytes: 1 }, 0), {
    name: "TypeError",
    message: "an empty batch must have zero bytes and null timestamps"
  });
  assert.throws(() => checkFlush({ ...state, openedAtMs: 0 }, 0), TypeError);
  assert.throws(
    () =>
      checkFlush({ ...state, count: 1, bytes: 1, openedAtMs: 5, lastItemAtMs: 4, maxItems: 2 }, 5),
    {
      name: "RangeError",
      message: "state.lastItemAtMs must be at or after openedAtMs"
    }
  );
  assert.throws(
    () =>
      checkFlush({ ...state, count: 2, bytes: 1, openedAtMs: 0, lastItemAtMs: 0, maxItems: 1 }, 0),
    {
      name: "RangeError",
      message: "state.count exceeds maxItems"
    }
  );
  assert.throws(() => checkFlush({ ...state, maxItems: undefined }, 0), {
    name: "TypeError",
    message: "state.maxItems must be an integer"
  });
  assert.throws(() => checkFlush({ ...state, count: -1 }, 0), RangeError);
  assert.throws(() => checkFlush({ ...state, count: 1.5 }, 0), TypeError);
});

test("adding bytes past the safe integer range throws and leaves the prior state", () => {
  const wide = openBatch({
    maxItems: 10,
    maxBytes: Number.MAX_SAFE_INTEGER,
    maxAgeMs: 10000,
    idleMs: 10000
  });
  const filled = taken(wide, Number.MAX_SAFE_INTEGER - 1, 0);
  assert.equal(filled.decision.flush, false);
  assert.throws(() => taken(filled.state, 2, 1), {
    name: "RangeError",
    message: "batch bytes exceed the safe integer range"
  });
  assert.equal(filled.state.bytes, Number.MAX_SAFE_INTEGER - 1);
  assert.throws(() => taken(wide, Number.MAX_SAFE_INTEGER + 1, 0), TypeError);
});

test("the usage calls flush on idle, then flush one oversize item", () => {
  let state = createBatch({
    maxItems: 10,
    maxBytes: 100,
    maxAgeMs: 1000,
    idleMs: 250
  });
  let step = taken(state, 40, 0);
  state = step.state;
  assert.equal(step.closedBatch, null);
  assert.deepEqual(step.decision, {
    flush: false,
    reason: FlushReason.None,
    nextCheckMs: 250
  });

  step = taken(state, 40, 100);
  state = step.state;
  assert.equal(step.state.count, 2);
  assert.equal(step.state.bytes, 80);
  assert.equal(step.decision.nextCheckMs, 350);

  assert.deepEqual(checkFlush(state, 350), {
    flush: true,
    reason: FlushReason.Idle,
    nextCheckMs: null
  });
  state = markFlushed(state, 350);
  assert.equal(state.count, 0);

  step = taken(state, 150, 400);
  assert.equal(step.closedBatch, null);
  assert.equal(step.state.count, 1);
  assert.equal(step.state.bytes, 150);
  assert.deepEqual(step.decision, {
    flush: true,
    reason: FlushReason.Oversize,
    nextCheckMs: null
  });
});

test("addItem returns the state, the closed batch, and the decision", () => {
  const step = taken(openBatch(), 1, 0);
  assert.deepEqual(Object.keys(step).sort(), ["closedBatch", "decision", "state"]);
  assert.deepEqual(Object.keys(step.decision).sort(), ["flush", "nextCheckMs", "reason"]);
  assert.deepEqual(Object.keys(step.state).sort(), [
    "bytes",
    "count",
    "idleMs",
    "lastItemAtMs",
    "maxAgeMs",
    "maxBytes",
    "maxItems",
    "openedAtMs"
  ]);
});

test("flush reasons stay the stable strings in priority order", () => {
  assert.deepEqual(FLUSH_REASONS, ["count", "oversize", "bytes", "age", "idle", "none"]);
  assert.equal(FlushReason.Count, "count");
  assert.equal(FlushReason.Oversize, "oversize");
  assert.equal(FlushReason.Bytes, "bytes");
  assert.equal(FlushReason.Age, "age");
  assert.equal(FlushReason.Idle, "idle");
  assert.equal(FlushReason.None, "none");
  assert.equal(Object.isFrozen(FlushReason), true);
  assert.equal(Object.isFrozen(FLUSH_REASONS), true);
  assert.throws(() => {
    FlushReason.Count = "other";
  }, TypeError);
});

test("a flush decision uses none only when flush is false, and then nextCheckMs is in the future", () => {
  const waiting = taken(openBatch(), 3, 10);
  assert.equal(waiting.decision.flush, false);
  assert.equal(waiting.decision.reason, FlushReason.None);
  assert.ok(waiting.decision.nextCheckMs > 10);
  const due = checkFlush(waiting.state, waiting.decision.nextCheckMs);
  assert.equal(due.flush, true);
  assert.notEqual(due.reason, FlushReason.None);
  assert.equal(due.nextCheckMs, null);
});

test("source files import only sibling modules", () => {
  for (const name of ["batch.js", "plan.js", "index.js"]) {
    const source = readFileSync(new URL("../src/" + name, import.meta.url), "utf8");
    const lines = source.split("\n").filter((line) => line.startsWith("import "));
    for (const line of lines) {
      assert.match(line, /from "\.\/[a-z]+\.js";$/);
    }
    assert.equal(source.includes("node:"), false);
  }
});
