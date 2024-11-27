from fastapi import APIRouter

# Import all route modules
from .frames import router as frames_router
from .log import router as log_router

api_router = APIRouter()

# Include the routers
api_router.include_router(frames_router, prefix="/frames")
api_router.include_router(log_router, prefix="/log")