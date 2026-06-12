#!/usr/bin/env python3
"""Safety/portability/disclaimer tests for btc-predict (re-applied 2026-06-12).
Scope = ONLY the safety re-apply (TLS verify, disclaimer/framing, portability).
The matching ALGORITHM + look-ahead refactor are NOT tested here (see test_lookahead.py).
Run: python -m unittest test_btc_predict -v   (no network needed)
"""
import os, ssl, importlib.util, unittest, tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("btc_predict", os.path.join(_HERE, "btc_predict.py"))
bp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bp)


class TestDisclaimer(unittest.TestCase):
    def test_required_phrases_present(self):
        banner = bp.disclaimer_banner()
        self.assertIn("NOT A FORECAST / NOT A TRADING SIGNAL", banner)
        self.assertIn("does not beat base-rate", banner)
        self.assertIn("did not beat climatology", banner)

    def test_framing_historical_analog_distribution(self):
        self.assertIn("historical analog distribution", bp.disclaimer_banner())

    def test_disclaimer_lines_not_weakened(self):
        self.assertEqual(bp.DISCLAIMER_LINES[0], "NOT A FORECAST / NOT A TRADING SIGNAL")
        self.assertIn("climatology", bp.DISCLAIMER_LINES[2])


class TestTLS(unittest.TestCase):
    def test_tls_verification_enabled(self):
        # Never CERT_NONE — verification must be ON.
        self.assertEqual(bp._SSL_CTX.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(bp._SSL_CTX.check_hostname)


class TestPortability(unittest.TestCase):
    def test_temp_paths_not_hardcoded_tmp(self):
        tmp = tempfile.gettempdir()
        for p in (bp.CHART_PATH, bp.HTML_PATH, bp.RESULT_PATH):
            self.assertTrue(p.startswith(tmp), f"{p} not under tempfile.gettempdir()")
            self.assertFalse(p.startswith("/tmp/"), f"{p} still hardcodes /tmp")


if __name__ == "__main__":
    unittest.main(verbosity=2)
