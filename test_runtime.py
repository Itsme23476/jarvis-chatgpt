import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import commands
import memory
import runtime


class SubscriptionTests(unittest.TestCase):
    def test_api_keys_cannot_leak_to_codex(self):
        with patch.dict(os.environ, {key: 'not-a-real-key' for key in (
                'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'FISH_AUDIO_API_KEY')}):
            child = runtime.subscription_env()
        self.assertFalse(any(key in child for key in (
            'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'FISH_AUDIO_API_KEY')))

    def test_both_invocations_require_chatgpt_auth(self):
        for schema in [None, Path('delivery.schema.json')]:
            command = runtime.build_command('Hello', speech_schema=schema)
            self.assertIn('forced_login_method="chatgpt"', command)
            self.assertIn('model_provider="openai"', command)
            self.assertIn('--ignore-user-config', command)
            self.assertNotIn('--bare', command)
            self.assertNotIn('--dangerously-bypass-approvals-and-sandbox', command)

    def test_invalid_resume_id_does_not_become_a_cli_argument(self):
        self.assertNotIn('resume', runtime.build_command('Hello', '--help'))

    def test_error_is_not_reported_as_completed(self):
        mapped = list(runtime.Events().map({'type': 'turn.failed', 'error': {'message': 'Login required'}}))
        self.assertEqual(mapped, [{'t': 'error', 'message': 'Login required'}])

    def test_normal_questions_always_reach_the_model(self):
        for message in ['Hello Jarvis, how are you doing?', 'What do we have planned for today?',
                        'Did we get any new leads in?', 'Reply to them both and get them on my calendar',
                        'Find us new leads and promote our AI audit', 'Did you find them?', 'Show me a demo']:
            self.assertIsNone(commands.handle(message), message)

    def test_fresh_empty_vault_is_usable(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(memory, 'VAULT', Path(tmp)), \
                patch.object(commands, 'STATE_FILE', Path(tmp) / 'state.json'):
            result = commands.handle('/vault')
            self.assertIn('0 notes', result['reply'])
            self.assertIn('Add Markdown', result['reply'])
            self.assertIsNone(commands.handle('What do we have planned for today?'))
        memory.build_graph(force=True)


if __name__ == '__main__':
    unittest.main()
