"""Service-level tests for the topics-clustering service.

Run locally (no Python CI exists in this repo yet — see #3174 spike notes):

    cd apps/topics-clustering
    python3 -m venv .venv && . .venv/bin/activate
    pip install -r requirements.txt -r requirements-dev.txt
    pytest
"""

import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest
from fastapi.testclient import TestClient

import app.main as main
from app.clustering import resolve_min_cluster_size
from app.main import app


def _two_blob_payload(per_cluster: int = 12, dim: int = 16) -> dict:
    """Two tight, well-separated groups — deterministic, no sklearn needed."""
    rng = np.random.default_rng(7)
    a = rng.normal(loc=0.0, scale=0.05, size=(per_cluster, dim)) + np.array(
        [5.0] + [0.0] * (dim - 1)
    )
    b = rng.normal(loc=0.0, scale=0.05, size=(per_cluster, dim)) + np.array(
        [-5.0] + [0.0] * (dim - 1)
    )
    vectors = np.vstack([a, b]).astype(float)
    return {
        "embeddings": [
            {"id": f"vec-{i}", "vector": row.tolist()}
            for i, row in enumerate(vectors)
        ],
        "options": {"minClusterSize": 5},
    }


def test_health_is_open_even_when_secret_set(monkeypatch):
    monkeypatch.setenv("TOPICS_CLUSTERING_SECRET", "s3cret")
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_cluster_rejects_missing_or_wrong_secret(monkeypatch):
    monkeypatch.setenv("TOPICS_CLUSTERING_SECRET", "s3cret")
    with TestClient(app) as client:
        missing = client.post("/cluster", json={"embeddings": []})
        wrong = client.post(
            "/cluster", json={"embeddings": []}, headers={"x-topics-secret": "nope"}
        )
    assert missing.status_code == 401
    assert wrong.status_code == 401


def test_cluster_accepts_correct_secret_and_no_secret_mode(monkeypatch):
    monkeypatch.setenv("TOPICS_CLUSTERING_SECRET", "s3cret")
    with TestClient(app) as client:
        ok = client.post(
            "/cluster",
            json={"embeddings": []},
            headers={"x-topics-secret": "s3cret"},
        )
    assert ok.status_code == 200

    monkeypatch.delenv("TOPICS_CLUSTERING_SECRET", raising=False)
    with TestClient(app) as client:
        open_mode = client.post("/cluster", json={"embeddings": []})
    assert open_mode.status_code == 200


def test_two_separated_groups_cluster_into_two_topics():
    payload = _two_blob_payload()
    with TestClient(app) as client:
        response = client.post("/cluster", json=payload)
    assert response.status_code == 200
    body = response.json()

    assert len(body["clusters"]) == 2
    member_counts = sorted(len(c["memberIds"]) for c in body["clusters"])
    assert member_counts == [12, 12]
    assert body["noise"] == []
    # Every input id accounted for exactly once.
    all_ids = sorted(
        [m for c in body["clusters"] for m in c["memberIds"]] + body["noise"]
    )
    assert all_ids == sorted(e["id"] for e in payload["embeddings"])
    assert body["generationMs"] > 0


def test_below_min_vectors_short_circuits_to_all_noise():
    payload = {
        "embeddings": [
            {"id": f"v{i}", "vector": [float(i), 1.0, 0.0]} for i in range(3)
        ]
    }
    with TestClient(app) as client:
        response = client.post("/cluster", json=payload)
    body = response.json()
    assert body["clusters"] == []
    assert sorted(body["noise"]) == ["v0", "v1", "v2"]


def test_cluster_calls_are_single_flight(monkeypatch):
    """The single-flight gate must serialize the whole allocate+cluster path
    (parse -> matrix -> cluster), so concurrent /cluster calls never run the
    heavy work at once and can't OOM the instance in parallel. We instrument
    cluster_embeddings to record peak concurrency across three simultaneous
    requests and assert it never exceeds one."""
    real_cluster = main.cluster_embeddings
    lock = threading.Lock()
    state = {"active": 0, "peak": 0}

    def instrumented(ids, vectors, min_cluster_size=None):
        with lock:
            state["active"] += 1
            state["peak"] = max(state["peak"], state["active"])
        try:
            time.sleep(0.15)  # widen the window where overlap could occur
            return real_cluster(ids, vectors, min_cluster_size=min_cluster_size)
        finally:
            with lock:
                state["active"] -= 1

    monkeypatch.setattr(main, "cluster_embeddings", instrumented)

    payload = _two_blob_payload()
    with TestClient(app) as client:
        with ThreadPoolExecutor(max_workers=3) as pool:
            responses = list(
                pool.map(lambda _: client.post("/cluster", json=payload), range(3))
            )

    assert [r.status_code for r in responses] == [200, 200, 200]
    assert state["peak"] == 1  # never two clustering jobs in flight at once


def test_resolve_min_cluster_size_scaling():
    # Caller override wins, but is floored at 2 (HDBSCAN rejects < 2, which
    # would 500 the endpoint on `minClusterSize: 1`).
    assert resolve_min_cluster_size(50_000, 7) == 7
    assert resolve_min_cluster_size(50_000, 1) == 2
    # Auto-scale: floor 5, n//50, capped at 100.
    assert resolve_min_cluster_size(100, None) == 5
    assert resolve_min_cluster_size(1_500, None) == 30
    assert resolve_min_cluster_size(4_000, None) == 80
    assert resolve_min_cluster_size(5_000, None) == 100
    assert resolve_min_cluster_size(500_000, None) == 100


def test_cluster_with_min_cluster_size_one_does_not_500():
    """A request pinning minClusterSize=1 must cluster (or return noise), not
    crash — the override is floored to 2 before reaching HDBSCAN."""
    payload = _two_blob_payload()
    payload["options"] = {"minClusterSize": 1}
    with TestClient(app) as client:
        response = client.post("/cluster", json=payload)
    assert response.status_code == 200
