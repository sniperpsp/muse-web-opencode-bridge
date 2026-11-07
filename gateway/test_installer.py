import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import instalar


class NvidiaProfilesTest(unittest.TestCase):
    def test_profiles_pin_one_model_directly(self):
        profiles = instalar.nvidia_blocks()
        self.assertEqual(set(profiles), {provider for provider, _, _ in instalar.NVIDIA_MODELS})
        for provider, model, label in instalar.NVIDIA_MODELS:
            profile = profiles[provider]
            self.assertEqual(profile["npm"], "@ai-sdk/openai-compatible")
            self.assertEqual(profile["options"]["baseURL"], "https://integrate.api.nvidia.com/v1")
            self.assertIn("nvidia.key", profile["options"]["apiKey"])
            self.assertEqual(list(profile["models"]), [model])
            self.assertEqual(profile["models"][model]["name"], label)
            self.assertTrue(profile["models"][model]["tool_call"])
            self.assertEqual(profile["models"][model]["attachment"], provider in instalar.NVIDIA_VISION)
            self.assertEqual(profile["models"][model]["modalities"]["input"], ["text", "image"] if provider in instalar.NVIDIA_VISION else ["text"])

    def test_legacy_aggregate_removal_preserves_other_provider(self):
        text = '''{
  "provider": {
    "gateway-nvidia": { "options": { "baseURL": "http://127.0.0.1:4351/v1" }, "models": { "gt-nvidia": {} } },
    "beatapi": { "models": { "free": {} } }
  }
}'''
        updated, removed = instalar.remove_legacy_nvidia_provider(text)
        config = json.loads(updated)
        self.assertTrue(removed)
        self.assertNotIn("gateway-nvidia", config["provider"])
        self.assertIn("beatapi", config["provider"])

        last = '''{"provider":{"beatapi":{"models":{"free":{}}},"gateway-nvidia":{"models":{"gt-nvidia":{}}}}}'''
        updated_last, removed_last = instalar.remove_legacy_nvidia_provider(last)
        self.assertTrue(removed_last)
        self.assertEqual(list(json.loads(updated_last)["provider"]), ["beatapi"])

    def test_remove_obsolete_model_preserves_unrelated_provider(self):
        text = '{"provider":{"nvidia-kimi":{"models":{"old":{}}},"beatapi":{"models":{"free":{}}}}}'
        updated, removed = instalar.remove_legacy_nvidia_provider(text, "nvidia-kimi")
        self.assertTrue(removed)
        self.assertEqual(list(json.loads(updated)["provider"]), ["beatapi"])
        self.assertEqual(len(instalar.NVIDIA_MODELS), 7)

    def test_register_adds_profiles_without_replacing_existing_provider(self):
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "opencode.json"
            config_path.write_text(json.dumps({"provider": {"beatapi": {"models": {"free": {}}}}}))
            with patch.object(instalar, "say"):
                self.assertTrue(instalar.register(config_path, instalar.nvidia_blocks()))
            config = json.loads(config_path.read_text())
            self.assertIn("beatapi", config["provider"])
            self.assertEqual(len([key for key in config["provider"] if key.startswith("nvidia-")]), len(instalar.NVIDIA_MODELS))


if __name__ == "__main__":
    unittest.main()
