import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import lab


class ReconstructionTests(unittest.TestCase):
    def test_domain_is_exhaustive_and_partitions_do_not_overlap(self):
        self.assertEqual(len(lab.DOMAIN), 128)
        self.assertEqual(len(set(lab.DOMAIN)), 128)
        self.assertFalse(set(lab.PROBES) & set(lab.ASSESSMENT))
        self.assertEqual(set(lab.PROBES) | set(lab.ASSESSMENT), set(lab.DOMAIN))

    def test_original_recompiled_matches_behavior_and_function_bytes(self):
        result = lab.evaluate(lab.ROOT / 'reference/score.c')
        self.assertEqual(result['matches'], 128)
        self.assertTrue(result['function_text_byte_match'])

    def test_starter_is_incorrect_and_returns_actionable_counterexamples(self):
        result = lab.evaluate(lab.ROOT / 'fixtures/starter.c')
        self.assertLess(result['matches'], 128)
        self.assertFalse(result['function_text_byte_match'])
        self.assertTrue(result['counterexamples'])

    def test_higher_aggregate_score_can_still_regress_correct_inputs(self):
        partial = lab.ROOT / 'fixtures/partial.c'
        starter = lab.ROOT / 'fixtures/starter.c'
        self.assertGreater(lab.evaluate(partial)['matches'], lab.evaluate(starter)['matches'])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertFalse(lab.gate(partial, starter))
            self.assertTrue(lab.gate(lab.ROOT / 'reference/score.c', starter))

    def test_compile_error_is_an_error_not_a_behavioral_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp) / 'broken.c'
            candidate.write_text('not valid C !!!')
            with self.assertRaises(subprocess.CalledProcessError):
                lab.evaluate(candidate)

    def test_regression_is_rejected_against_a_better_explicit_baseline(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertFalse(lab.gate(lab.ROOT / 'fixtures/starter.c', lab.ROOT / 'reference/score.c'))

    def test_strict_exit_code_distinguishes_measurement_from_success(self):
        bad = subprocess.run(['python3', 'lab.py', 'evaluate', '--strict', '--candidate', 'fixtures/starter.c'],
                             cwd=lab.ROOT, capture_output=True, text=True)
        good = subprocess.run(['python3', 'lab.py', 'evaluate', '--strict', '--candidate', 'reference/score.c'],
                              cwd=lab.ROOT, capture_output=True, text=True)
        self.assertEqual(bad.returncode, 1)
        self.assertEqual(good.returncode, 0)

    def test_replay_preserves_candidate_and_marks_scripted_proposals(self):
        original = (lab.ROOT / 'candidate/score.c').read_bytes()
        with contextlib.redirect_stdout(io.StringIO()):
            record = lab.replay()
        self.assertEqual(record['model_calls'], 0)
        self.assertTrue(record['final_proposal_is_supplied_ground_truth'])
        self.assertEqual([x['decision'] for x in record['attempts']], ['baseline', 'rejected', 'rejected', 'accepted'])
        self.assertEqual(record['attempts'][-1]['matches'], 128)
        self.assertEqual((lab.ROOT / 'candidate/score.c').read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
