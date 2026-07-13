import assert from "node:assert/strict";
import test from "node:test";

import { metricDateRange, parseMetricsCsv, requiredMetricDates } from "./metrics-data.mjs";

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

test("metrics parser collapses identical source duplicates and preserves missing taker ratio as null", () => {
  const header = "create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio";
  const row = "2020-10-22 02:50:00,BTCUSDT,44269.121,565741581.22,1.21,1.19,1.44,";
  const rows = parseMetricsCsv(`${header}\n${row}\n${row}\n`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].takerRatio, null);
});

test("metrics parser rejects conflicting duplicates", () => {
  const header = "create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio";
  const first = "2020-10-22 02:50:00,BTCUSDT,44269.121,565741581.22,1.21,1.19,1.44,1.1";
  const second = "2020-10-22 02:50:00,BTCUSDT,44270.000,565741581.22,1.21,1.19,1.44,1.1";
  assert.throws(() => parseMetricsCsv(`${header}\n${first}\n${second}\n`), /METRICS_DUPLICATE_CONFLICT/);
});

test("metrics parser maps official outage zeros and quoted blanks to null", () => {
  const header = "create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio";
  const row = '2023-06-06 11:25:00,BTCUSDT,0E-8,0E-8,"",1.19,2.91,0.76';
  const [value] = parseMetricsCsv(`${header}\n${row}\n`);
  assert.equal(value.openInterest, null);
  assert.equal(value.openInterestValue, null);
  assert.equal(value.topAccountRatio, null);
  assert.equal(value.topPositionRatio, 1.19);
});

test("metrics parser preserves off-second official event timestamps", () => {
  const header = "create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio";
  const row = "2024-03-04 05:35:01,BTCUSDT,76937.539,4877039822.19,1.16,1.43,1.12,0.41";
  const [value] = parseMetricsCsv(`${header}\n${row}\n`);
  assert.equal(value.time, Date.UTC(2024, 2, 4, 5, 35, 1));
});

test("metric date range is inclusive and UTC-stable", () => {
  assert.deepEqual(metricDateRange("2024-02-28", "2024-03-01"), [
    "2024-02-28", "2024-02-29", "2024-03-01",
  ]);
});
