import assert from "node:assert/strict";
import test from "node:test";

import { parseMetricsCsv, requiredMetricDates } from "./metrics-data.mjs";

test("metrics parser validates schema and converts timestamps to UTC milliseconds", () => {
  const text = [
    "create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio",
    "2023-01-01 00:00:00,BTCUSDT,100,200,1.2,1.1,1.3,0.9",
    "2023-01-01 00:05:00,BTCUSDT,101,202,1.3,1.2,1.4,1.1",
    "",
  ].join("\n");
  const rows = parseMetricsCsv(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].time, Date.UTC(2023, 0, 1));
  assert.equal(rows[1].openInterest, 101);
  assert.equal(rows[1].takerRatio, 1.1);
});

test("required dates include the signal date and seven prior UTC dates without duplicates", () => {
  const dates = requiredMetricDates([
    { signalTime: Date.UTC(2023, 0, 10, 4) },
    { signalTime: Date.UTC(2023, 0, 11, 4) },
  ]);
  assert.deepEqual(dates, [
    "2023-01-03", "2023-01-04", "2023-01-05", "2023-01-06", "2023-01-07",
    "2023-01-08", "2023-01-09", "2023-01-10", "2023-01-11",
  ]);
});
