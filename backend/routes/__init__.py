"""Dataiki API Routes Package."""

from backend.routes.flow_group_routes import router as flow_group_router
from backend.routes.gateway_routes import router as gateway_router
from backend.routes.lab_routes import router as lab_router
from backend.routes.ml_routes import router as ml_router
from backend.routes.production_routes import router as production_router
from backend.routes.system_routes import router as system_router

__all__ = [
    "system_router",
    "lab_router",
    "ml_router",
    "production_router",
    "flow_group_router",
    "gateway_router",
]
