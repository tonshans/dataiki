"""Centralized sandbox for user-supplied Python snippets.

Every non-freestyle execution path (recipe py_transform, DAG nodes, batch job
scripts, custom endpoints) goes through this module so the built-in whitelist
lives in exactly one place.

engine/script_runner.py is intentionally NOT routed here: Freestyle Script Lab
runs with full __builtins__ and is gated by the ALLOW_FREESTYLE feature flag.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, Optional

import duckdb
import numpy as np
import polars as pl

# Whitelist: safe built-ins only. No open/os/eval/exec/import/compile.
SAFE_BUILTINS: Dict[str, Any] = {
    "len": len,
    "range": range,
    "enumerate": enumerate,
    "zip": zip,
    "map": map,
    "filter": filter,
    "list": list,
    "dict": dict,
    "set": set,
    "tuple": tuple,
    "str": str,
    "int": int,
    "float": float,
    "bool": bool,
    "min": min,
    "max": max,
    "sum": sum,
    "abs": abs,
    "round": round,
    "sorted": sorted,
    "reversed": reversed,
    "isinstance": isinstance,
    "issubclass": issubclass,
    "hasattr": hasattr,
    "getattr": getattr,
    "print": print,
    "repr": repr,
    "type": type,
    "any": any,
    "all": all,
    "ValueError": ValueError,
    "TypeError": TypeError,
    "KeyError": KeyError,
    "Exception": Exception,
}


def load_sandboxed_function(
    code: str,
    func_name: str,
    extra_globals: Optional[Dict[str, Any]] = None,
) -> Callable:
    """Execute user code in the sandbox and return the requested function.

    Args:
        code: Python source defining func_name.
        func_name: Name of the callable to extract (e.g. "transform").
        extra_globals: Extra names injected into the sandbox (e.g. {"dataiki": sdk}).

    Returns:
        The callable defined by the script.

    Raises:
        ValueError: If the script does not define a callable named func_name.
    """
    sandbox_globals: Dict[str, Any] = {
        "pl": pl,
        "np": np,
        "duckdb": duckdb,
        "json": json,
    }
    if extra_globals:
        sandbox_globals.update(extra_globals)
    # Always last: extra_globals must never widen the built-in whitelist.
    sandbox_globals["__builtins__"] = SAFE_BUILTINS

    sandbox_locals: Dict[str, Any] = {}
    exec(code, sandbox_globals, sandbox_locals)

    fn = sandbox_locals.get(func_name) or sandbox_globals.get(func_name)
    if not callable(fn):
        raise ValueError(
            f"Script does not define callable function '{func_name}'."
        )
    return fn
