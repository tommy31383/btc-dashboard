#!/usr/bin/env python3
"""Regression tests for btc-predict safety correction.
Run: python -m unittest test_btc_predict -v   (no network, no cache needed)
"""
import os, ssl, importlib.util, unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("btc_predict", os.path.join(_HERE, "btc_predict.py"))
bp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bp)


class TestDisclaimer(unittest.TestCase):
    def test_required_phrases_present(self):
        banner = bp.disclaimer_banner(7)
        self.assertIn("NOT A FORECAST / NOT A TRADING SIGNAL", banner)
        self.assertIn("R1 primary result: CRPS skill -0.0533, IC 0.0101", banner)
        self.assertIn("Analog method did not beat climatology.", banner)

    def test_effective_sample_shown(self):
        self.assertIn("7 effective independent samples", bp.disclaimer_banner(7))

    def test_disclaimer_lines_constant_not_weakened(self):
        self.assertEqual(bp.DISCLAIMER_LINES[0], "NOT A FORECAST / NOT A TRADING SIGNAL")
        self.assertIn("CRPS skill -0.0533", bp.DISCLAIMER_LINES[1])
        self.assertIn("IC 0.0101", bp.DISCLAIMER_LINES[1])


class TestClosedCandle(unittest.TestCase):
    def _kline(self, open_ms, interval=86_400_000):
        # Binance kline: [openTime, o,h,l,c,v, closeTime, ...]
        return [open_ms, "1", "1", "1", "1", "1", open_ms + interval - 1]

    def test_drops_forming_candle(self):
        day = 86_400_000
        bars = [self._kline(0), self._kline(day), self._kline(2 * day)]
        # now is in the middle of the 3rd candle → it is still forming
        now = 2 * day + day // 2
        out = bp.drop_partial_daily(bars, now)
        self.assertEqual(len(out), 2, "the forming (unclosed) candle must be dropped")
        self.assertEqual(out[-1][0], day)

    def test_keeps_all_when_all_closed(self):
        day = 86_400_000
        bars = [self._kline(0), self._kline(day)]
        now = 5 * day  # well after both closed
        self.assertEqual(len(bp.drop_partial_daily(bars, now)), 2)


class TestNonOverlap(unittest.TestCase):
    def test_kept_analogs_have_nonoverlapping_forward_windows(self):
        # indices clustered close together; high scores on near-duplicates
        matches = [{"hist_index": i, "score": 100 - i} for i in range(100, 140)]
        kept = bp.dedup_nonoverlap(matches, bp.LOOK_FWD, bp.MAX_MATCHES)
        idx = sorted(m["hist_index"] for m in kept)
        for a, b in zip(idx, idx[1:]):
            self.assertGreaterEqual(b - a, bp.LOOK_FWD,
                                    "kept analogs must be >= LOOK_FWD apart (forward windows non-overlap)")

    def test_dedup_gap_equals_look_fwd(self):
        self.assertEqual(bp.DEDUP_DAYS, bp.LOOK_FWD)


class TestTLS(unittest.TestCase):
    def test_tls_verification_enabled(self):
        self.assertEqual(bp._SSL_CTX.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(bp._SSL_CTX.check_hostname)


if __name__ == "__main__":
    unittest.main(verbosity=2)
