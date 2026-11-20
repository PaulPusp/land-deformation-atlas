"""Serve the atlas and run bounded, single-instance processing jobs."""
import logging
import math
import os
import re
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from tempfile import TemporaryDirectory
from threading import Lock

import requests
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from processor import process

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
executor = ThreadPoolExecutor(max_workers=1)
lock = Lock()
jobs = {}
ttl = 1800


class Selection(BaseModel):
    granule: str
    box: tuple[float, float, float, float]


def run_job(key, selection):
    dataset = None
    error = None
    try:
        with TemporaryDirectory(prefix="atlas-") as directory:
            dataset = process(selection.granule, selection.box, directory)
    except ValueError as exc:
        error = str(exc)
    except requests.RequestException:
        logging.exception("Archive request failed")
        error = "The archive download could not be completed."
    except Exception:
        logging.exception("Granule processing failed")
        error = "The granule layout could not be processed."
    with lock:
        jobs[key] = {
            "state": "failed" if error else "complete",
            "error": error, "dataset": dataset, "expires": time.monotonic() + ttl,
        }


@app.post("/api/jobs", status_code=202)
def create(selection: Selection):
    if not os.environ.get("EARTHDATA_TOKEN"):
        raise HTTPException(503, "Earthdata access is not configured on this server.")
    if not re.fullmatch(r"G[0-9]{1,14}-ASF", selection.granule):
        raise HTTPException(422, "Choose a valid ASF product.")
    w, s, e, n = selection.box
    if not all(map(math.isfinite, selection.box)) or not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
        raise HTTPException(422, "Choose valid geographic bounds.")
    if e - w > 2 or n - s > 2:
        raise HTTPException(422, "Reduce the AOI to at most 2° on each axis.")
    with lock:
        now = time.monotonic()
        for key in [key for key, job in jobs.items() if job.get("expires", math.inf) <= now]:
            del jobs[key]
        if len(jobs) >= 12 or sum(j["state"] == "running" for j in jobs.values()) >= 2:
            raise HTTPException(429, "The processing service is busy. Try again later.")
        key = secrets.token_urlsafe(24)
        jobs[key] = {"state": "running"}
        executor.submit(run_job, key, selection)
    return {"id": key}


@app.get("/api/jobs/{key}")
def status(key: str):
    with lock:
        job = jobs.get(key)
        if not job or job.get("expires", math.inf) <= time.monotonic():
            raise HTTPException(404, "This processing job has expired.")
        return {k: v for k, v in job.items() if k != "expires"}


app.mount("/", StaticFiles(directory="docs", html=True))
