"""
Benchmark for the topics-clustering POC (#3174).

Generates synthetic 1024-D embeddings (matching Stage 3's
`FacetEmbeddingOk.embedding` shape) at increasing scale, times UMAP +
HDBSCAN + a full HTTP roundtrip, and reports cluster count / noise % /
silhouette score at each scale point.

If WORKSHOP_EMBEDDINGS_PATH is set to a JSON file shaped like
`{"embeddings": [{"id": str, "vector": [float, ...]}, ...]}`, it is
benchmarked too. Per the spike findings on #3174, no such fixture exists
in the repo yet, so this path is best-effort and silently skipped if the
env var is unset or the file is missing.
"""

import gc
import json
import os
import time

import numpy as np
from sklearn.datasets import make_blobs
from sklearn.metrics import silhouette_score

from app.clustering import DEFAULT_MIN_CLUSTER_SIZE, NOISE_LABEL, cluster_embeddings
from app.main import app

EMBEDDING_DIM = 1024
SCALE_POINTS = [100, 1_000, 5_000, 10_000, 50_000]
SILHOUETTE_SAMPLE_CAP = 5_000
NOISE_FRACTION = 0.05


def make_synthetic_embeddings(n: int, seed: int = 0) -> tuple[list[str], np.ndarray]:
    """Real Stage-3 traffic clusters into a long tail of topics with some
    outliers, not uniform noise. Blobs-in-a-subspace + a slice of pure
    random noise approximates that shape better than pure `np.random`,
    which is ~equidistant in 1024-D and degenerates to all-noise."""
    rng = np.random.default_rng(seed)
    n_noise = max(1, int(n * NOISE_FRACTION)) if n >= 20 else 0
    n_clustered = n - n_noise
    n_centers = max(2, min(50, n_clustered // 50))

    clustered, _ = make_blobs(
        n_samples=n_clustered,
        n_features=EMBEDDING_DIM,
        centers=n_centers,
        cluster_std=2.5,
        random_state=seed,
    )
    noise = rng.uniform(low=-15, high=15, size=(n_noise, EMBEDDING_DIM))

    vectors = np.vstack([clustered, noise]) if n_noise else clustered
    rng.shuffle(vectors)

    ids = [f"vec-{i}" for i in range(n)]
    # Return the float32 ndarray, not a Python list-of-lists: at 50k×1024 the
    # list form is ~1.4GB of boxed floats vs ~205MB for the array. The HTTP
    # roundtrip materializes a transient list only when serializing, then frees it.
    return ids, vectors.astype(np.float32)


def compute_silhouette(reduced: np.ndarray, labels: np.ndarray) -> float | None:
    mask = labels != NOISE_LABEL
    if mask.sum() < 2 or len(set(labels[mask].tolist())) < 2:
        return None
    sample_size = SILHOUETTE_SAMPLE_CAP if mask.sum() > SILHOUETTE_SAMPLE_CAP else None
    return float(
        silhouette_score(reduced[mask], labels[mask], sample_size=sample_size, random_state=0)
    )


def benchmark_scale(n: int) -> dict:
    ids, vectors = make_synthetic_embeddings(n)

    result = cluster_embeddings(ids, vectors, min_cluster_size=DEFAULT_MIN_CLUSTER_SIZE)
    cluster_count = len({l for l in result.labels if l != NOISE_LABEL})
    noise_pct = 100.0 * (result.labels == NOISE_LABEL).sum() / n
    silhouette = compute_silhouette(result.reduced, result.labels)
    umap_ms = result.umap_ms
    hdbscan_ms = result.hdbscan_ms
    del result
    gc.collect()

    http_ms = benchmark_http_roundtrip(ids, vectors)
    del vectors
    gc.collect()

    return {
        "n": n,
        "umap_ms": round(umap_ms, 1),
        "hdbscan_ms": round(hdbscan_ms, 1),
        "total_generation_ms": round(umap_ms + hdbscan_ms, 1),
        "http_roundtrip_ms": round(http_ms, 1),
        "cluster_count": cluster_count,
        "noise_pct": round(noise_pct, 1),
        "silhouette": round(silhouette, 3) if silhouette is not None else None,
    }


def benchmark_http_roundtrip(ids: list[str], vectors: np.ndarray) -> float:
    import orjson
    from fastapi.testclient import TestClient

    # Serialize once, then drop the transient structures before the POST so the
    # source vectors and the server-side parsed copy don't both sit in memory at
    # 50k×1024 — that simultaneous peak OOM-killed the container. orjson with
    # OPT_SERIALIZE_NUMPY streams the ndarray rows straight to JSON, skipping the
    # ~1.4GB list-of-lists that `vectors.tolist()` would materialize.
    payload = {"embeddings": [{"id": i, "vector": v} for i, v in zip(ids, vectors)]}
    body = orjson.dumps(payload, option=orjson.OPT_SERIALIZE_NUMPY)
    del payload
    gc.collect()

    with TestClient(app) as client:
        start = time.perf_counter()
        response = client.post(
            "/cluster", content=body, headers={"content-type": "application/json"}
        )
        elapsed_ms = (time.perf_counter() - start) * 1000
    response.raise_for_status()
    return elapsed_ms


def benchmark_workshop_traces() -> dict | None:
    path = os.environ.get("WORKSHOP_EMBEDDINGS_PATH")
    if not path or not os.path.exists(path):
        return None

    with open(path) as f:
        data = json.load(f)
    ids = [e["id"] for e in data["embeddings"]]
    vectors = [e["vector"] for e in data["embeddings"]]

    result = cluster_embeddings(ids, vectors, min_cluster_size=DEFAULT_MIN_CLUSTER_SIZE)
    cluster_count = len({l for l in result.labels if l != NOISE_LABEL})
    noise_pct = 100.0 * (result.labels == NOISE_LABEL).sum() / len(ids)
    silhouette = compute_silhouette(result.reduced, result.labels)

    return {
        "n": len(ids),
        "cluster_count": cluster_count,
        "noise_pct": round(noise_pct, 1),
        "silhouette": round(silhouette, 3) if silhouette is not None else None,
    }


def main() -> None:
    print(f"{'n':>7} | {'umap_ms':>9} | {'hdbscan_ms':>10} | {'total_ms':>9} | "
          f"{'http_ms':>9} | {'clusters':>8} | {'noise_%':>8} | {'silhouette':>10}")
    print("-" * 100)

    for n in SCALE_POINTS:
        result = benchmark_scale(n)
        print(
            f"{result['n']:>7} | {result['umap_ms']:>9} | {result['hdbscan_ms']:>10} | "
            f"{result['total_generation_ms']:>9} | {result['http_roundtrip_ms']:>9} | "
            f"{result['cluster_count']:>8} | {result['noise_pct']:>8} | "
            f"{result['silhouette']!s:>10}"
        )

    workshop_result = benchmark_workshop_traces()
    if workshop_result:
        print("\nWorkshop traces:")
        print(workshop_result)
    else:
        print(
            "\nWORKSHOP_EMBEDDINGS_PATH not set or file not found — "
            "skipping workshop-trace benchmark (see #3174 spike notes)."
        )


if __name__ == "__main__":
    main()
