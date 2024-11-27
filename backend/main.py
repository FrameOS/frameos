import os
from fastapi import FastAPI, Request
from sqlmodel import create_engine

from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api import api_router


sqlite_file_name = "../db/frameos.db"
sqlite_url = f"sqlite:///{sqlite_file_name}"

connect_args = {"check_same_thread": False}
engine = create_engine(sqlite_url, connect_args=connect_args)

app = FastAPI()
app.include_router(api_router, prefix="/api")

app.mount("/assets", StaticFiles(directory="../frontend/dist/assets"), name="assets")
app.mount("/img", StaticFiles(directory="../frontend/dist/img"), name="img")
app.mount("/static", StaticFiles(directory="../frontend/dist/static"), name="static")

non_404_routes = ("/api", "/assets", "/img", "/static")

@app.get("/")
async def read_index():
    index_path = os.path.join("../frontend/dist", "index.html")
    return FileResponse(index_path)

@app.exception_handler(StarletteHTTPException)
async def custom_404_handler(request: Request, exc: StarletteHTTPException):
    if exc.status_code == 404 and not request.url.path.startswith(non_404_routes):
        index_path = os.path.join("../frontend/dist", "index.html")
        return FileResponse(index_path)
    return JSONResponse(status_code=404, content={"message": "Not Found"})

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    index_path = os.path.join("../frontend/dist", "index.html")
    return FileResponse(index_path)

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8989, log_level="debug")
