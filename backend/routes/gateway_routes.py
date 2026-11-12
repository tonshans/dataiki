"""Dataiki Dynamic Custom REST API Gateway.

Dispatches requests dynamically to user-defined production endpoint handlers:
- Wildcard route: GET and POST /api/v1/{project_key}/{custom_path:path}
- Flow Group API: GET and POST /api/v1/{project_key}/flow/{group_slug}
- Injects global 'dataiki' SDK instance into script execution context.
- Enforces Fail-Fast Recipe contract: raises HTTP 422 Unprocessable Entity if
  input record is rejected by recipe filters or data type casts.
"""

from __future__ import annotations

import json
from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Request, Response, status

from backend.database import get_db
from backend.engine.recipe_engine import RecipeValidationError
from backend.engine.runtime_sdk import execute_custom_endpoint_script

router = APIRouter(prefix="/api/v1", tags=["Dynamic Production Gateway"])


async def _handle_dynamic_request(
    project_key: str,
    custom_path: str,
    request: Request,
) -> Any:
    """Internal dispatcher for dynamic custom endpoints and flow group API calls."""
    method = request.method.upper().strip()
    path_with_slash = "/" + custom_path.strip("/")
    path_without_slash = custom_path.strip("/")

    # ------------------------------------------------------------------
    # Flow Group API Gateway: /flow/{group_slug}
    # Falls through to custom endpoints when no flow group matches, so an
    # existing user endpoint literally named 'flow/...' keeps working.
    # ------------------------------------------------------------------
    if path_without_slash.startswith("flow/"):
        from backend.engine.flow_group_runner import run_flow_group
        group_slug = path_without_slash[len("flow/"):].strip("/")

        with get_db() as conn:
            fg_row = conn.execute(
                """
                SELECT group_id, is_api_enabled FROM flow_groups
                WHERE project_key = ? AND group_slug = ?
                LIMIT 1
                """,
                (project_key, group_slug),
            ).fetchone()

        if fg_row and not fg_row["is_api_enabled"]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    f"Flow group API '{group_slug}' is not exposed for project "
                    f"'{project_key}'. Enable 'Expose as REST API' in the group settings."
                ),
            )

        if fg_row:
            # Parse request payload
            input_payload: Dict[str, Any] = {}
            if method == "POST":
                try:
                    input_payload = await request.json()
                except Exception:
                    input_payload = {}
            else:
                input_payload = dict(request.query_params)

            try:
                result = run_flow_group(
                    group_id=fg_row["group_id"],
                    input_payload=input_payload,
                    output_format="json",
                )
                if result.get("status") == "error":
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail={"error": result.get("error"), "group_slug": group_slug},
                    )
                return result
            except HTTPException:
                raise
            except Exception as exc:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=f"Flow group execution error: {exc}",
                ) from exc

    # ------------------------------------------------------------------
    # Custom Script Endpoint Gateway (original logic)
    # ------------------------------------------------------------------
    # Search endpoint definition in database
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT * FROM custom_endpoints
            WHERE project_key = ?
              AND http_method = ?
              AND (custom_path = ? OR custom_path = ?)
              AND is_enabled = 1
            LIMIT 1
            """,
            (project_key, method, path_with_slash, path_without_slash),
        ).fetchone()

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dynamic endpoint '{method} /{custom_path}' not found or disabled for project '{project_key}'.",
        )

    endpoint_dict = dict(row)

    # Parse request payload or query parameters
    payload_or_query: Dict[str, Any] = {}
    if method == "POST":
        try:
            payload_or_query = await request.json()
        except Exception:
            payload_or_query = {}
    else:
        payload_or_query = dict(request.query_params)

    # Execute custom inference script in sandbox
    try:
        result = execute_custom_endpoint_script(
            project_key=project_key,
            endpoint_row=endpoint_dict,
            payload_or_query=payload_or_query,
        )
        return result
    except RecipeValidationError as exc:
        # Enforce Fail-Fast Production Contract (HTTP 422)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "RecipeValidationError",
                "message": exc.message,
                "step_label": exc.step_label,
                "record_index": exc.record_index,
            },
        ) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error executing custom endpoint script: {exc}",
        ) from exc


@router.get("/{project_key}/{custom_path:path}")
async def dynamic_get_endpoint(
    project_key: str,
    custom_path: str,
    request: Request,
) -> Any:
    """Handle dynamic GET requests for user published custom endpoints."""
    return await _handle_dynamic_request(project_key, custom_path, request)


@router.post("/{project_key}/{custom_path:path}")
async def dynamic_post_endpoint(
    project_key: str,
    custom_path: str,
    request: Request,
) -> Any:
    """Handle dynamic POST requests with JSON payload and fail-fast validation."""
    return await _handle_dynamic_request(project_key, custom_path, request)

