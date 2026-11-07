"""Dataiki configuration and storage path management."""

from pathlib import Path

# Base Paths
BASE_DIR: Path = Path(__file__).resolve().parent.parent
BACKEND_DIR: Path = BASE_DIR / "backend"
STORAGE_DIR: Path = BASE_DIR / "storage"

# Storage Subdirectories
UPLOADS_DIR: Path = STORAGE_DIR / "uploads"
CACHE_DIR: Path = STORAGE_DIR / "cache"
ARTIFACTS_DIR: Path = STORAGE_DIR / "artifacts"
EXPORTS_DIR: Path = STORAGE_DIR / "exports"

# Database Path
DB_PATH: Path = STORAGE_DIR / "registry.db"
DATABASE_URL: str = f"sqlite:///{DB_PATH.as_posix()}"

# Ensure directories exist
ALL_STORAGE_DIRS = [
    STORAGE_DIR,
    UPLOADS_DIR,
    CACHE_DIR,
    ARTIFACTS_DIR,
    EXPORTS_DIR,
]


def ensure_directories() -> None:
    """Ensure all required runtime storage directories exist."""
    for directory in ALL_STORAGE_DIRS:
        directory.mkdir(parents=True, exist_ok=True)


# Auto-initialize storage directories on import
ensure_directories()

