import json
import unittest
from unittest.mock import patch

import delivery
import runtime


class DeliveryTests(unittest.TestCase):
    def test_authored_speech_preserves_inline_and_scoped_tags_without_ai_call(self):
        script = ('[breathless, speaking fast, urgent] Sir, you need to see this. '
                  '[voice drops to a terrified whisper] …they’re already inside. '
                  '<emphasis> Do not open that door. </emphasis>')
        with patch.object(runtime, 'run') as runner:
            self.assertEqual(delivery.prepare(script, mode='scripted'), (script, []))
        runner.assert_not_called()
        with self.assertRaises(ValueError):
            delivery.prepare('', mode='scripted')
        with self.assertRaises(ValueError):
            delivery.prepare('Hello', mode='unknown')

    def test_preserves_every_word_and_literal_brackets(self):
        text = 'The value is [42].\nΚαλημέρα! Your balance is 3.50 euros.'
        segments = delivery.segments_for(text)
        plan = {'directions': [{'segment': 0, 'delivery': 'warm and clear'},
                               {'segment': 2, 'delivery': 'measured and factual'}]}
        directed, inserted = delivery.apply_plan(text, segments, plan)
        restored = directed
        for item in inserted:
            restored = restored.replace('[' + item['delivery'] + '] ', '', 1)
        self.assertEqual(restored, text)
        self.assertIn('[42]', directed)
        self.assertIn('3.50 euros.', directed)

    def test_rejects_bad_or_injected_directions(self):
        segments = delivery.segments_for('Hello. Next sentence.')
        invalid = [[], [{'segment': 1, 'delivery': 'calm'}],
                   [{'segment': 0, 'delivery': '[shout] extra words'}],
                   [{'segment': 0, 'delivery': '<whisper>'}],
                   [{'segment': 0, 'delivery': 'calm\nnew header'}],
                   [{'segment': 99, 'delivery': 'calm'}],
                   [{'segment': True, 'delivery': 'calm'}],
                   [{'segment': 0, 'delivery': 'calm'}, {'segment': 0, 'delivery': 'warm'}]]
        for plan in invalid:
            with self.subTest(plan=plan), self.assertRaises(ValueError):
                delivery.apply_plan('Hello. Next sentence.', segments, {'directions': plan})

    def test_model_only_supplies_direction_not_rewritten_answer(self):
        events = [{'t': 'delta', 'text': json.dumps({'directions': [
            {'segment': 0, 'delivery': 'gentle reassurance, steady pace'}]})}, {'t': 'complete'}]
        with patch.object(runtime, 'run', return_value=iter(events)) as runner:
            directed, _ = delivery.prepare('We can fix this.', 'I feel worried.')
        self.assertEqual(directed, '[gentle reassurance, steady pace] We can fix this.')
        self.assertEqual(runner.call_args.kwargs['speech_schema'], delivery.SCHEMA)
        self.assertIn('I feel worried.', runner.call_args.args[0])

    def test_failed_or_incomplete_review_never_gets_a_default_tag(self):
        for events in [[{'t': 'error', 'message': 'rate limited'}],
                       [{'t': 'delta', 'text': '{}'}],
                       [{'t': 'delta', 'text': 'not JSON'}, {'t': 'complete'}]]:
            with patch.object(runtime, 'run', return_value=iter(events)), self.assertRaises(RuntimeError):
                delivery.prepare('Hello.')

    def test_director_is_ephemeral_and_does_not_resume_chat(self):
        command = runtime.build_command('Direct this', '01a17355-e872-73b3-befd-3c0fb206770a',
                                        speech_schema=delivery.SCHEMA)
        self.assertIn('--ephemeral', command)
        self.assertIn('read-only', command)
        self.assertNotIn('resume', command)
        self.assertNotIn('--approve-for-me', command)
        self.assertNotIn('sandbox_workspace_write.network_access=true', command)
        self.assertIn('forced_login_method="chatgpt"', command)
        self.assertIn('shell_tool', command)

    def test_existing_conversation_still_resumes(self):
        sid = '01a17355-e872-73b3-befd-3c0fb206770a'
        command = runtime.build_command('Follow up', sid)
        self.assertEqual(command[-4:], ['resume', sid, '--', 'Follow up'])
        self.assertIn('--approve-for-me', command)
        self.assertIn('sandbox_workspace_write.network_access=true', command)


if __name__ == '__main__':
    unittest.main()
