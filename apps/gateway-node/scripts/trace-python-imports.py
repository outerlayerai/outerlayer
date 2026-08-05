"""Trace local Python file dependencies and external imports from an entry point.

Uses stdlib modulefinder to resolve imports transitively.
Outputs JSON to stdout:
  {
    "local_files": ["handler.py", "lib/utils.py", ...],
    "external_imports": ["openai", "anthropic", "agentmark", ...]
  }

local_files  — repo-relative paths of every .py file reachable from the entry
               point. Used to copy only needed sources into the deploy image.
external_imports — top-level module names that modulefinder could not resolve
               (i.e. not in the repo and not stdlib). Used to generate
               requirements.txt via PyPI name mapping on the TS side.

Exits 0 on success, 1 on failure (JSON error on stderr).
"""

import json
import os
import sys
from modulefinder import ModuleFinder


def _non_package_dirs(abs_repo: str) -> list[str]:
    """Top-level dirs without __init__.py — not Python packages.

    modulefinder's PEP 420 namespace-package handling crashes when a
    non-package directory shadows a real PyPI module name and user code
    imports deeply into that shadowed name (e.g. a local ``agentmark/``
    prompts folder vs. the ``agentmark`` PyPI package when handler imports
    ``from agentmark.prompt_core import X``). Excluding these directories
    from modulefinder's scan avoids the crash; imports into them fall
    through to badmodules → external_imports, which is the right answer
    when the intended target is actually a PyPI package.
    """
    excludes = []
    for entry in os.listdir(abs_repo):
        if entry.startswith('.'):
            continue
        full = os.path.join(abs_repo, entry)
        if os.path.isdir(full) and not os.path.isfile(os.path.join(full, '__init__.py')):
            excludes.append(entry)
    return excludes


def trace(repo_dir: str, entry_point: str) -> dict[str, list[str]]:
    abs_repo = os.path.abspath(repo_dir)
    abs_entry = os.path.join(abs_repo, entry_point)

    if not os.path.isfile(abs_entry):
        raise FileNotFoundError(f"Entry point not found: {entry_point}")

    # Limit the search path to the repo so third-party packages fall into
    # badmodules (where we want them) instead of being resolved from the
    # builder's own site-packages.
    finder = ModuleFinder(path=[abs_repo], excludes=_non_package_dirs(abs_repo))
    try:
        finder.run_script(abs_entry)
    except Exception as e:
        # modulefinder has a handful of edge-case bugs (namespace packages,
        # certain conditional imports). If it crashes, salvage whatever it
        # resolved before the crash — partial data is better than nothing,
        # and the caller still has scan-all-files as a deeper fallback.
        print(
            f"# modulefinder partial: {type(e).__name__}: {e}",
            file=sys.stderr,
        )

    files = set()
    for _, mod in finder.modules.items():
        if mod.__file__ and os.path.isabs(mod.__file__):
            try:
                rel = os.path.relpath(mod.__file__, abs_repo)
                if not rel.startswith(".."):
                    files.add(rel)
                    # Include __init__.py for parent packages so Python can
                    # import them at runtime.
                    parts = rel.split(os.sep)
                    for i in range(1, len(parts)):
                        init = os.path.join(*parts[:i], "__init__.py")
                        if os.path.isfile(os.path.join(abs_repo, init)):
                            files.add(init)
            except ValueError:
                pass

    files.add(entry_point)

    # Third-party imports live in badmodules as fully-qualified names
    # (e.g. "openai.types.chat"). Collapse to the top-level package and
    # drop stdlib (stdlib_module_names is available on Python 3.10+).
    stdlib = getattr(sys, "stdlib_module_names", frozenset())
    external_imports = set()
    for bad_name in finder.badmodules.keys():
        top = bad_name.split(".", 1)[0]
        if top and top not in stdlib:
            external_imports.add(top)

    return {
        "local_files": sorted(files),
        "external_imports": sorted(external_imports),
    }


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(
            json.dumps({"error": "Usage: trace-python-imports.py <repo_dir> <entry_point>"}),
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        json.dump(trace(sys.argv[1], sys.argv[2]), sys.stdout)
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
