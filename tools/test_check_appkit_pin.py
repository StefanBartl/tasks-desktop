"""The parsing of the two lock files, without the network: what passes and what is named."""

import importlib.util
import pathlib
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("check_appkit_pin", HERE / "check-appkit-pin.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

SHA = "0123456789abcdef0123456789abcdef01234567"
OTHER = "fedcba9876543210fedcba9876543210fedcba98"

CARGO = f'''
[[package]]
name = "appkit-core"
version = "0.0.0"
source = "git+https://github.com/StefanBartl/appkit?tag=v0.3.0#{SHA}"

[[package]]
name = "appkit-hub"
version = "0.0.0"
source = "git+https://github.com/StefanBartl/appkit?tag=v0.3.0#{SHA}"

[[package]]
name = "serde"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
'''

PNPM = f'''
importers:

  .:
    dependencies:
      appkit-ui:
        specifier: github:StefanBartl/appkit#v0.3.0&path:ui-kit
        version: https://codeload.github.com/StefanBartl/appkit/tar.gz/{SHA}#path:ui-kit(svelte@5.57.1)
    devDependencies:
      vite:
        specifier: ^8.3.2
        version: 8.3.4
'''


class CargoPins(unittest.TestCase):
    def test_the_packages_of_the_kit_pin_one_tag_and_commit(self):
        pins, problems = MODULE.pinned(MODULE.appkit_packages(CARGO))
        self.assertEqual(problems, [])
        self.assertEqual(pins, {("v0.3.0", SHA)})

    def test_a_branch_instead_of_a_tag_is_named(self):
        text = CARGO.replace("?tag=v0.3.0", "?branch=main")
        _, problems = MODULE.pinned(MODULE.appkit_packages(text))
        self.assertTrue(any("not by a tag" in p for p in problems), problems)


class UiPin(unittest.TestCase):
    def test_the_page_pins_the_folder_of_the_kit_by_the_tag(self):
        self.assertEqual(MODULE.ui_pin(PNPM), (("v0.3.0", SHA), []))

    def test_a_link_to_a_checkout_is_named(self):
        text = PNPM.replace(
            "specifier: github:StefanBartl/appkit#v0.3.0&path:ui-kit",
            "specifier: link:../../appkit/ui-kit",
        ).replace(
            f"version: https://codeload.github.com/StefanBartl/appkit/tar.gz/{SHA}#path:ui-kit(svelte@5.57.1)",
            "version: link:../../appkit/ui-kit",
        )
        pin, problems = MODULE.ui_pin(text)
        self.assertIsNone(pin)
        self.assertTrue(any("not the folder ui-kit" in p for p in problems), problems)

    def test_the_git_url_form_of_the_specifier_is_read_too(self):
        text = PNPM.replace(
            "specifier: github:StefanBartl/appkit#v0.3.0&path:ui-kit",
            "specifier: git+https://github.com/StefanBartl/appkit.git#v0.3.0&path:ui-kit",
        ).replace(
            f"version: https://codeload.github.com/StefanBartl/appkit/tar.gz/{SHA}#path:ui-kit(svelte@5.57.1)",
            f"version: git+https://github.com/StefanBartl/appkit.git#{SHA}&path:ui-kit",
        )
        self.assertEqual(MODULE.ui_pin(text), (("v0.3.0", SHA), []))

    def test_a_page_without_the_kit_is_named(self):
        pin, problems = MODULE.ui_pin("importers:\n  .:\n    dependencies:\n      vite:\n        specifier: ^8\n        version: 8.3.4\n")
        self.assertIsNone(pin)
        self.assertTrue(any("does not pin appkit-ui" in p for p in problems), problems)

    def test_another_commit_than_the_hub_is_a_different_pin(self):
        pin, _ = MODULE.ui_pin(PNPM.replace(SHA, OTHER))
        pins, _ = MODULE.pinned(MODULE.appkit_packages(CARGO))
        self.assertNotIn(pin, pins)


if __name__ == "__main__":
    unittest.main()
