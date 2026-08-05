import asyncio
import hmac
import os
import time

import numpy as np
import orjson
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import ORJSONResponse

from app.clustering import cluster_embeddings, group_by_cluster
from app.models import Cluster, ClusterResponse, HealthResponse

# orjson end-to-end: at the 50k×1024 ceiling the request body is ~1GB of JSON.
# Pydantic per-float validation of 51M floats cost ~40-50s and held a ~1.4GB
# boxed-float copy alive (the memory pressure that made generation time vary
# run-to-run). orjson parses the same body in a few seconds straight into a
# numpy array, so the roundtrip clears the <60s AC1 bound with margin.
app = FastAPI(title="topics-clustering", default_response_class=ORJSONResponse)

# Single-flight: one clustering job at a time. A second concurrent /cluster
# waits here instead of doubling peak memory (two 50k float32 matrices).
_cluster_gate = asyncio.Semaphore(1)


def _check_auth(request: Request) -> None:
    """Shared-secret auth. When the env var is unset
    (local dev / docker compose default) the endpoint is open; deployments set
    TOPICS_CLUSTERING_SECRET and callers send it in `x-topics-secret`."""
    secret = os.environ.get("TOPICS_CLUSTERING_SECRET", "")
    if not secret:
        return
    provided = request.headers.get("x-topics-secret", "")
    if not hmac.compare_digest(provided.encode(), secret.encode()):
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/cluster")
async def cluster(request: Request) -> ClusterResponse:
    _check_auth(request)

    # Single-flight spans the entire large-allocation lifecycle, not just the
    # cluster call. At the 50k×1024 ceiling the raw body is ~1GB, parsing it
    # into Python floats is ~1.4GB, and the matrix adds ~205MB — all before
    # clustering. Gating only cluster_embeddings left two concurrent requests
    # free to read + parse + build matrices simultaneously and OOM the instance
    # before either reached the gate. Holding the gate from the body read
    # through clustering bounds peak memory to one in-flight job. Parse and
    # cluster run via asyncio.to_thread so the event loop keeps serving
    # /health for the whole job — a liveness probe can't mark a busy instance
    # unhealthy mid-run.
    async with _cluster_gate:
        body = await request.body()
        payload = await asyncio.to_thread(orjson.loads, body)
        del body
        embeddings = payload.get("embeddings") or []
        options = payload.get("options") or {}
        min_cluster_size = options.get(
            "minClusterSize", options.get("min_cluster_size")
        )

        start = time.perf_counter()

        ids = [e["id"] for e in embeddings]
        matrix = np.asarray([e["vector"] for e in embeddings], dtype=np.float32)
        # Free the parsed JSON structure before clustering so the boxed-float
        # copy and the numpy matrix don't peak in memory together at 50k.
        del payload, embeddings

        result = await asyncio.to_thread(
            cluster_embeddings, ids, matrix, min_cluster_size
        )

    grouped = group_by_cluster(result)

    clusters = [
        Cluster(
            id=f"cluster-{label}",
            # Naming happens in the caller's pipeline (LLM/keyword pass);
            # the service stays a pure geometry engine.
            name=f"cluster-{label}",
            description="",
            member_ids=member_ids,
        )
        for label, member_ids in sorted(grouped["groups"].items())
    ]

    generation_ms = (time.perf_counter() - start) * 1000

    return ClusterResponse(
        clusters=clusters,
        noise=grouped["noise"],
        generation_ms=generation_ms,
    )
