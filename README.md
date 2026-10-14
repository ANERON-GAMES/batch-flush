# batch-flush

Decide when a write batch should flush by count, bytes, age, or idle gap. The caller keeps the buffer, the clock, and the I/O.

Log shipping, metric uploads, bulk inserts, and telemetry all wait for the same four limits: enough records, enough bytes, an oldest record that has sat too long, or a quiet gap after the last record. This package answers only that question. It stores a count, a byte total, and two timestamps. It does not keep the records, read a clock, open a socket, or write a batch.

## Install

The package is an ES module. It needs Node.js 20 or newer. It has no runtime dependencies. The package name is `@aneron/batch-flush`. It is not published to the npm registry.

Clone this repository and run the tests:

```bash
git clone https://github.com/ANERON-GAMES/batch-flush.git
cd batch-flush
npm install
npm test
```

`npm test` runs `node --test`. `npm run lint` runs ESLint. `npm run format:check` runs Prettier.

Install it as a dependency from the git repository:

```bash
npm install github:ANERON-GAMES/batch-flush
```

```js
import { addItem, checkFlush, createBatch, markFlushed, planFlushes } from "@aneron/batch-flush";
```

Code in this repository imports the same entry point with `./src/index.js`.

## Usage

A batch starts empty. Each call passes the time. The returned `nextCheckMs` is the only timer the caller needs: it is the earliest moment a time rule could fire.

```js
import { addItem, checkFlush, createBatch, markFlushed, planFlushes } from "@aneron/batch-flush";

const options = {
  maxItems: 10,
  maxBytes: 100,
  maxAgeMs: 1000,
  idleMs: 250
};

let state = createBatch(options);
const buffer = [];

function take(bytes, nowMs) {
  const step = addItem(state, { bytes, nowMs });
  if (step.closedBatch != null) {
    send(buffer.splice(0, buffer.length), step.closedBatch.reason);
  }
  buffer.push(bytes);
  state = step.state;
  if (step.decision.flush) {
    send(buffer.splice(0, buffer.length), step.decision.reason);
    state = markFlushed(state, nowMs);
  }
  return step.decision.nextCheckMs;
}

function onTimer(nowMs) {
  const decision = checkFlush(state, nowMs);
  if (!decision.flush) {
    return decision.nextCheckMs;
  }
  send(buffer.splice(0, buffer.length), decision.reason);
  state = markFlushed(state, nowMs);
  return null;
}

function send(batch, reason) {
  return { batch, reason };
}
```

`buffer` holds whatever the caller ships. The library never sees those values. `take` returns the next timer time, or `null` when nothing is waiting. `onTimer` runs at that time.

```js
const firstTimer = take(40, 0);
const secondTimer = take(40, 100);
const idleDecision = checkFlush(state, 350);
```

`firstTimer` is `250`. One 40-byte record is open, and the idle limit is the earlier deadline. `secondTimer` is `350`. The batch now holds 2 records and 80 bytes, still under both size limits, and the idle deadline moved to `100 + 250`. `idleDecision` is `{ flush: true, reason: "idle", nextCheckMs: null }`. Age would not be due until `1000`. After that flush:

```js
send(buffer.splice(0, buffer.length), idleDecision.reason);
state = markFlushed(state, 350);
const oversizeTimer = take(150, 400);
```

`state.count` is `0` before `take`. `oversizeTimer` is `null`. The 150-byte record is larger than `maxBytes`, so the decision is `{ flush: true, reason: "oversize", nextCheckMs: null }` and the batch holds that one record.

The same rules replay a list that was saved with its timestamps:

```js
const plan = planFlushes(
  [
    { bytes: 40, atMs: 0 },
    { bytes: 40, atMs: 100 },
    { bytes: 10, atMs: 1000 }
  ],
  options
);
```

`plan.batches[0]` is the idle flush of the first two records, closed at `350`. `plan.pending.state` is the open 10-byte record from `1000`. `checkFlush(plan.pending.state, 1000).nextCheckMs` is `1250`.

## API reference

All functions are pure. They do not read the clock, the network, or the filesystem. They do not mutate their arguments. Every returned object is frozen.

### Constants

| Export               | Value     | Meaning                                                          |
| -------------------- | --------- | ---------------------------------------------------------------- |
| `DEFAULT_MAX_ITEMS`  | `100`     | Flush when the batch holds this many records.                    |
| `DEFAULT_MAX_BYTES`  | `1048576` | Flush when the byte total reaches 1 MiB.                         |
| `DEFAULT_MAX_AGE_MS` | `5000`    | Flush when the oldest record has been open for 5 seconds.        |
| `DEFAULT_IDLE_MS`    | `1000`    | Flush when a non-empty batch has had no new record for 1 second. |

`createBatch()` and `planFlushes(items)` use these when the matching option is omitted.

### `FlushReason`

Frozen. The fields and the strings are the same values.

| Field      | Value        | Meaning                                                                           |
| ---------- | ------------ | --------------------------------------------------------------------------------- |
| `Count`    | `"count"`    | `count` has reached `maxItems`.                                                   |
| `Oversize` | `"oversize"` | The batch is one record whose `bytes` is greater than `maxBytes`.                 |
| `Bytes`    | `"bytes"`    | The byte total has reached `maxBytes`, or the byte limit refused the next record. |
| `Age`      | `"age"`      | The age of the oldest record has reached `maxAgeMs`.                              |
| `Idle`     | `"idle"`     | The gap since the last record has reached `idleMs`, and the batch is not empty.   |
| `None`     | `"none"`     | No rule has fired. `flush` is `false` exactly in this case.                       |

`FLUSH_REASONS` is a frozen array of those strings, in the order `count`, `oversize`, `bytes`, `age`, `idle`, `none`. That is the decision order. `none` means the earlier rules did not match.

### Batch state

```js
{
  count: 0,
  bytes: 0,
  openedAtMs: null,
  lastItemAtMs: null,
  maxItems: 100,
  maxBytes: 1048576,
  maxAgeMs: 5000,
  idleMs: 1000
}
```

| Field          | Type             | Meaning                                                         |
| -------------- | ---------------- | --------------------------------------------------------------- |
| `count`        | number           | Records in the open batch. `0` when the batch is empty.         |
| `bytes`        | number           | Byte total of those records. `0` when the batch is empty.       |
| `openedAtMs`   | number or `null` | Timestamp of the oldest record. `null` when the batch is empty. |
| `lastItemAtMs` | number or `null` | Timestamp of the newest record. `null` when the batch is empty. |
| `maxItems`     | number           | Count limit copied from the options.                            |
| `maxBytes`     | number           | Byte limit copied from the options.                             |
| `maxAgeMs`     | number           | Age limit copied from the options.                              |
| `idleMs`       | number           | Idle limit copied from the options.                             |

The state does not contain the records. Two calls from the same state are two futures: the first state stays usable.

An empty state has `count` `0`, `bytes` `0`, and both timestamps `null`. A non-empty state has `count` from `1` through `maxItems`, a byte total that is a safe integer of zero or more, and `lastItemAtMs` at or after `openedAtMs`.

### Decision

```js
{
  flush: false,
  reason: "none",
  nextCheckMs: null
}
```

| Field         | Type             | Meaning                                                                                              |
| ------------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| `flush`       | boolean          | `true` when the caller should ship the open batch now.                                               |
| `reason`      | string           | A `FlushReason` string. `"none"` when `flush` is `false`, and never `"none"` when `flush` is `true`. |
| `nextCheckMs` | number or `null` | The earliest time a time rule could fire. `null` when `flush` is `true` or the batch is empty.       |

When `flush` is `false` and the batch is not empty, `nextCheckMs` is `min(openedAtMs + maxAgeMs, lastItemAtMs + idleMs)`, and that value is greater than the `nowMs` just supplied. Schedule one timer for it. A record that arrives sooner replaces that timer with the decision from `addItem`.

### `createBatch(options)`

Return a new empty state.

`options` may be omitted or an object. `null`, an array, and any other value throw `TypeError`.

| Field      | Type   | Role                                                                                                     |
| ---------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `maxItems` | number | Positive integer. Omitted means `DEFAULT_MAX_ITEMS`.                                                     |
| `maxBytes` | number | Positive integer. Omitted means `DEFAULT_MAX_BYTES`.                                                     |
| `maxAgeMs` | number | Finite number of zero or more. Omitted means `DEFAULT_MAX_AGE_MS`. `0` ages a record immediately.        |
| `idleMs`   | number | Finite number of zero or more. Omitted means `DEFAULT_IDLE_MS`. `0` makes a new record idle immediately. |

A non-integer `maxItems` or `maxBytes` throws `TypeError`. An integer below `1` throws `RangeError`. A non-finite duration throws `TypeError`. A negative duration throws `RangeError`. Unknown fields are ignored. Later changes to the options object do not change the state.

### `addItem(state, item)`

Admit one record, then decide.

| Argument | Type   | Role                                            |
| -------- | ------ | ----------------------------------------------- |
| `state`  | object | A state returned by this package.               |
| `item`   | object | `{ bytes, nowMs }`. Unknown fields are ignored. |

`bytes` is a safe integer of zero or more. A zero-byte record still counts toward `maxItems`. `nowMs` is a finite number. On a non-empty batch it must be at or after `lastItemAtMs`. The same timestamp as the previous record is allowed. A backward clock throws `RangeError`.

The return value is `{ state, closedBatch, decision }`.

| Field         | Type             | Meaning                                                                       |
| ------------- | ---------------- | ----------------------------------------------------------------------------- |
| `state`       | object           | The open batch after this record was admitted. It always contains the record. |
| `closedBatch` | object or `null` | A batch that closed without this record. `null` when nothing closed first.    |
| `decision`    | object           | The decision for the returned `state`.                                        |

`closedBatch` is `{ count, bytes, reason, openedAtMs, closedAtMs }`. Ship the caller's buffer up to, and not including, the new record. Then treat `state` as the batch that holds the new record. `closedAtMs` is the age deadline, the idle deadline, or `item.nowMs` for a count, byte, or oversize close.

`closedBatch` is set in two situations:

1. A flush rule is already true for the open batch at `item.nowMs`. The open batch closes for that reason. The new record starts a new batch. This is how a timer that should have fired at `nextCheckMs` stays ahead of a record that arrives at or after that time.
2. The open batch is under every limit, and `item.bytes` is greater than `maxBytes`. The open batch closes with reason `bytes`. Its own total may still be below `maxBytes`. The byte limit is what refused the record, so the oversized record can occupy a batch by itself. The returned state is that one record, and `decision.reason` is `"oversize"` unless `maxItems` is `1`, in which case `"count"` wins.

A record whose own size is at most `maxBytes` is admitted even when the new total passes `maxBytes`. The returned batch can be larger than `maxBytes` by that last record. The reason is `"bytes"` unless a higher rule also matches.

If the byte sum would pass `Number.MAX_SAFE_INTEGER`, `addItem` throws `RangeError` and returns nothing. The previous state is unchanged.

A bad `state` or `item` throws `TypeError` or `RangeError` before a new state is returned. See the errors under `checkFlush` for the state rules. Item errors use the messages `item must be an object`, `item.bytes must be an integer`, `item.bytes must be zero or greater`, `item.nowMs must be a finite number`, and `item.nowMs must be at or after the last item`.

### `checkFlush(state, nowMs)`

Decide whether the open batch should flush at `nowMs`. This is the timer call. It does not change the batch.

| Argument | Type   | Role                              |
| -------- | ------ | --------------------------------- |
| `state`  | object | A state returned by this package. |
| `nowMs`  | number | Finite timestamp.                 |

The return value is a decision.

The checks run in this order. The first match wins.

1. `count` is `0`: `{ flush: false, reason: "none", nextCheckMs: null }`. An empty batch never flushes, at any timestamp.
2. `count >= maxItems`: `count`.
3. `count` is `1` and `bytes > maxBytes`: `oversize`.
4. `bytes >= maxBytes`: `bytes`.
5. The age deadline `openedAtMs + maxAgeMs` is at or before `nowMs`, and it is at or before the idle deadline: `age`.
6. The idle deadline `lastItemAtMs + idleMs` is at or before `nowMs`: `idle`.
7. Otherwise: `none`, and `nextCheckMs` is the earlier of those two deadlines.

Age and idle are ordered by the deadline, with age winning a tie. A late check does not relabel a batch whose idle deadline came first. At time `5000`, a batch opened at `0` with `maxAgeMs` `1000` and `idleMs` `100` flushes with `"idle"`, because idle was due at `100`. The same batch with the two limits swapped flushes with `"age"`. Equal limits of `100` flush with `"age"` at `100`.

`nowMs` below `lastItemAtMs` on a non-empty batch throws `RangeError`. `nowMs` that is not a finite number throws `TypeError`.

`state` must be a non-array object. `count` and `bytes` must be safe integers of zero or more. The four limits must be valid, as in `createBatch`, and they are required on a state. An empty batch with a non-zero byte total or a non-null timestamp throws `TypeError`. `count` above `maxItems` throws `RangeError`. A non-empty batch with a missing or non-finite timestamp throws `TypeError`. `lastItemAtMs` before `openedAtMs` throws `RangeError`.

### `markFlushed(state, nowMs)`

Return a new empty state with the same limits.

| Argument | Type   | Role                                                                 |
| -------- | ------ | -------------------------------------------------------------------- |
| `state`  | object | The batch that was just shipped, or an empty state.                  |
| `nowMs`  | number | Finite timestamp, at or after `lastItemAtMs` when the batch is open. |

`nowMs` is validated and is not stored. The empty state has null timestamps. Calling `markFlushed` on an empty state returns another empty state. The previous state is not mutated. A backward `nowMs` throws `RangeError`. A bad state throws the same errors as `checkFlush`.

Call `markFlushed` after shipping the batch that `decision.flush` selected. Do not call it for `closedBatch`: that batch is already gone from the returned state.

### `planFlushes(items, options)`

Partition a saved list with the same rules as `addItem`, `checkFlush`, and `markFlushed`.

| Argument  | Type   | Role                                                                              |
| --------- | ------ | --------------------------------------------------------------------------------- |
| `items`   | array  | `{ bytes, atMs }` in non-decreasing `atMs` order. An empty array is a valid list. |
| `options` | object | The same options as `createBatch`. Omitted means the defaults.                    |

`items` must be an array. Each entry must be a non-array object. `bytes` follows the `addItem` rule. `atMs` must be a finite number at or after the previous entry's `atMs`. A bad entry throws `TypeError` or `RangeError` and names the index, for example `items[1].atMs must be at or after the previous item`. A bad options object throws the `createBatch` error. The input array and its objects are not mutated. Unknown fields on an entry are ignored.

The return value is `{ batches, pending }`.

`batches` is an array of closed batches, in time order:

| Field        | Type   | Meaning                                                                                                                                          |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `start`      | number | Inclusive index of the first record in this batch.                                                                                               |
| `end`        | number | Exclusive index after the last record in this batch.                                                                                             |
| `count`      | number | `end - start`.                                                                                                                                   |
| `bytes`      | number | Sum of `bytes` over that range.                                                                                                                  |
| `reason`     | string | The `FlushReason` that closed the batch. Never `"none"`.                                                                                         |
| `openedAtMs` | number | `atMs` of the first record in the batch.                                                                                                         |
| `closedAtMs` | number | When the batch closed. A size rule closes at the record's `atMs`. A time rule closes at its deadline, which can be earlier than the next record. |

`pending` is `null` when every record was flushed. Otherwise:

| Field   | Type   | Meaning                                               |
| ------- | ------ | ----------------------------------------------------- |
| `start` | number | Inclusive index of the first record still open.       |
| `end`   | number | Exclusive index. This is `items.length`.              |
| `state` | object | The open batch. Pass it to `checkFlush` or `addItem`. |

Every index appears in one closed batch or in `pending`. `planFlushes` does not invent a clock past the last record, so a tail that has not reached a limit stays pending even when a caller, later, would fire the timer. `checkFlush(pending.state, pending.state.openedAtMs)` tells that caller the `nextCheckMs` to wait for.

A record larger than `maxBytes` is always its own batch with reason `"oversize"`, unless `maxItems` is `1`, in which case the count rule wins and the record is still shipped. The record is not dropped. Records before it form their own batch. When those earlier records were under every limit, that earlier batch uses reason `"bytes"`.

## Design notes

The package is a decision table with a fixed order. Count is first because a full count is already a complete batch, including when that one record is also past the byte limit. Oversize is next so a single record that cannot fit is named `"oversize"` rather than `"bytes"`. The general byte rule is next. Age is next, then idle. An empty batch stops the table before any of those rules.

Age and idle share one clock. The deadline that comes first is the one that fires. When the deadlines are equal, age wins, because it is earlier in the table. A check that runs late still reports that earlier deadline. It does not switch the reason to whichever rule also happens to be true at the late timestamp.

`nextCheckMs` is how the caller keeps one timer. It is the earlier deadline while the batch is open and no rule has fired. It is `null` when the caller should flush now, and `null` when the batch is empty, because an empty batch has no deadline. After `markFlushed`, the next record creates the next deadline.

Size rules run at admission. A record at most `maxBytes` joins the batch and can push the total to or past `maxBytes`. The total "reaches" the limit by including that record. Every proper prefix of the batch stays below `maxBytes`. A record above `maxBytes` never joins a non-empty batch and is never dropped. It is shipped alone. The open batch closes so that can happen. That close is a byte-limit decision even when the open total has not itself reached `maxBytes`.

Time rules are evaluated before admission. A record that arrives at or after a deadline does not join the batch that deadline belongs to. `closedAtMs` for that close is the deadline, not the later record's timestamp. `planFlushes` does the same thing between saved timestamps. If the caller ignores a `flush: true` decision and calls `addItem` again, the due batch is returned as `closedBatch` and the new record starts fresh. The open state never grows past a rule that has already fired.

`markFlushed` is the only reset. `checkFlush` and a `flush: true` decision leave the totals in place so the caller can still read `count` and `bytes` while shipping. The library does not know whether the send succeeded.

Zero is a valid duration. `maxAgeMs` of `0` flushes on admission with `"age"`, unless count, oversize, or bytes already matched. `idleMs` of `0` flushes on admission with `"idle"` when age is still in the future. A zero-byte record is a real record for the count rule and adds nothing to the byte total.

Timestamps are the caller's numbers. They may be fractional, zero, or negative. The package compares them with ordinary numeric ordering and adds a duration with ordinary addition. It does not interpret them as wall-clock time.

This module does not store payloads, start timers, retry a send, split an oversized record into pieces, compress a batch, or decide what a byte count means. The caller chooses the records, the clock, the buffer, and the write.

## License

Released under the MIT License. The full text is in [LICENSE](LICENSE).
