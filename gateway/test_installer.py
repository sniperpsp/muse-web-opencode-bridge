import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import instalar


class NvidiaProfilesTest(unittest.TestCase):
    def test_profiles_pin_one_model_directly(self):
        profiles = instalar.nvidia_blocks()
        self.assertEqual(set(profiles), {provider for provider, *_ in instalar.NVIDIA_MODELS})
        for provider, model, label, purpose in instalar.NVIDIA_MODELS:
            self.assertTrue(label.startswith("GT NVIDIA "), label)
            self.assertLessEqual(len(label), 23, f"{label} é cortado no seletor do OpenCode")
            self.assertLessEqual(len(purpose), 28, f"{purpose} é cortado na parte cinza")
            profile = profiles[provider]
            self.assertEqual(profile["npm"], "@ai-sdk/openai-compatible")
            self.assertEqual(profile["options"]["baseURL"], "https://integrate.api.nvidia.com/v1")
            self.assertIn("nvidia.key", profile["options"]["apiKey"])
            self.assertEqual(list(profile["models"]), [model])
            self.assertEqual(profile["models"][model]["name"], label)
            self.assertEqual(profile["name"], purpose)
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
        self.assertEqual(len(instalar.NVIDIA_MODELS), 10)

    def test_nvidia_choice_flags_and_key_never_prompted_without_terminal(self):
        import argparse, io, tempfile
        from pathlib import Path
        from unittest import mock
        flags = lambda **kw: argparse.Namespace(**{"com_nvidia": False, "sem_nvidia": False, **kw})
        self.assertTrue(instalar.choose_nvidia(flags(com_nvidia=True)))
        self.assertFalse(instalar.choose_nvidia(flags(sem_nvidia=True)))
        with tempfile.TemporaryDirectory() as tmp:
            key = Path(tmp) / "nvidia.key"
            with mock.patch.object(instalar, "NVIDIA_KEY_FILE", key), \
                 mock.patch("sys.stdin", io.StringIO("")), \
                 mock.patch.object(instalar.subprocess, "run") as run:
                # sem chave e sem terminal (agente em segundo plano): não pede nada, só avisa
                self.assertFalse(instalar.ensure_nvidia_key())
                run.assert_not_called()
                key.write_text("nvapi-teste")
                self.assertTrue(instalar.ensure_nvidia_key())
                # sem terminal, o padrão da pergunta segue a chave já salva
                self.assertTrue(instalar.choose_nvidia(flags()))

    def test_windows_config_gets_key_in_windows_home(self):
        from pathlib import Path
        self.assertEqual(instalar.windows_key_target("/mnt/c/Users/ana/.config/opencode/opencode.jsonc"), Path("/mnt/c/Users/ana/.config/gateway/nvidia.key"))
        self.assertIsNone(instalar.windows_key_target("/home/ana/.config/opencode/opencode.jsonc"))

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
