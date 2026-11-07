"""Dataiki Backend Main Application Entrypoint.

Self-Hosted Lightweight Visual Data Science, AutoML & MLOps Studio.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncGenerator, Dict

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.config import ensure_directories
from backend.database import init_db
from backend.engine.job_scheduler import shutdown_scheduler, start_scheduler
from backend.routes import (
    gateway_router,
    lab_router,
    ml_router,
    production_router,
    system_router,
)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Manage application startup and shutdown lifecycle."""
    # Startup actions
    ensure_directories()
    init_db()
    start_scheduler()
    yield
    # Shutdown actions
    shutdown_scheduler()


app = FastAPI(
    title="Dataiki - Visual Data Science, AutoML & MLOps Studio",
    description="Self-Hosted Lightweight Studio for Visual Data Science, Screening, Tuning & Production Gateway.",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount API Routers
app.include_router(system_router)
app.include_router(lab_router)
app.include_router(ml_router)
app.include_router(production_router)
app.include_router(gateway_router)


@app.get("/api/health", tags=["System & Settings"])
def health_check() -> Dict[str, str]:
    """Primary application health probe."""
    return {"status": "ok", "app": "Dataiki", "version": "1.0.0"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)

