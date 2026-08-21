"""Ashoka Student Dashboard — API entrypoint."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import get_settings
from app.routers import ai, calendar, classroom, meta, push

settings = get_settings()

app = FastAPI(
    title="Ashoka Student Dashboard",
    version="0.1.0",
    docs_url="/docs",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(meta.router, tags=["meta"])
app.include_router(classroom.router, tags=["classroom"])
app.include_router(calendar.router, tags=["calendar"])
app.include_router(ai.router, tags=["ai"])
app.include_router(push.router, tags=["push"])
