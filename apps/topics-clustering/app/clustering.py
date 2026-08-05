import time
from dataclasses import dataclass
from typing import List, Optional, Union

import hdbscan
import numpy as np
import umap

# Sample-fit then assign, CPU-only, 50k-vector ceiling.
DEFAULT_MIN_CLUSTER_SIZE = 5
UMAP_N_COMPONENTS = 10
UMAP_N_NEIGHBORS = 15
UMAP_MIN_DIST = 0.0
# Pinned so fit time and cluster assignments are reproducible run-to-run.
# UMAP forces single-threaded optimization once random_state is set, trading a
# little speed for determinism — required so the <60s latency bound is a
# guarantee, not a coin flip (unseeded runs varied 20s–42s on identical 50k input).
UMAP_RANDOM_STATE = 42
NOISE_LABEL = -1
# scipy's eigsh (used by UMAP's spectral init) requires k < N; below this,
# dimensionality reduction is meaningless anyway, so skip straight to noise.
MIN_VECTORS_FOR_CLUSTERING = 5
# The "sample-fit then assign" decision, made concrete: fitting the
# UMAP manifold is O(N) and single-threaded once seeded, so at the 50k ceiling a
# full fit_transform runs ~30s and dominates the roundtrip. Above this many
# vectors we fit the manifold on a seeded random sample of exactly this size and
# transform() the remainder onto it. Fit cost is then bounded by the sample (not
# N), transform is cheap, and both stay deterministic — so the <60s latency
# bound holds with real margin at 50k instead of hugging the limit.
#
# 5000 is the knee: a single-threaded (seeded) fit on 5k×1024 runs ~10s, and 5k
# samples cover the ≤50 expected topic centers ~100 points deep — enough to learn
# the manifold without the ~30s a 10k fit costs. Measured at 50k: fit+transform
# ~15s, full roundtrip ~30s (vs 50s hugging the bar with a 10k fit sample).
UMAP_FIT_SAMPLE_SIZE = 5_000


@dataclass
class ClusteringResult:
    # member_ids[i] / reduced[i] line up with the input embeddings order.
    labels: np.ndarray
    member_ids: List[str]
    reduced: np.ndarray
    umap_ms: float
    hdbscan_ms: float


def resolve_min_cluster_size(n: int, override: Optional[int] = None) -> int:
    """Auto-scale min_cluster_size with corpus size unless the caller pins it.
    Topics are read by humans looking for patterns to act on, so granularity
    targets tens of topics, not hundreds: n/50 keeps ~<=50-topic granularity
    (a 1.5k corpus gets clusters of >=30 members instead of the 70+
    micro-topics a flat minimum produces), capped so huge corpora can't force
    over-merging.

    A caller override is floored at 2: HDBSCAN raises on min_cluster_size < 2,
    so `minClusterSize: 1` in the request would otherwise 500 the endpoint."""
    if override is not None and override > 0:
        return max(2, override)
    return min(100, max(DEFAULT_MIN_CLUSTER_SIZE, n // 50))


def cluster_embeddings(
    ids: List[str],
    vectors: Union[List[List[float]], np.ndarray],
    min_cluster_size: Optional[int] = None,
) -> ClusteringResult:
    if len(ids) != len(vectors):
        raise ValueError("ids and vectors must be the same length")

    matrix = np.asarray(vectors, dtype=np.float32)
    n = matrix.shape[0]
    effective_min_cluster_size = resolve_min_cluster_size(n, min_cluster_size)

    if n < MIN_VECTORS_FOR_CLUSTERING:
        return ClusteringResult(
            labels=np.full(n, NOISE_LABEL),
            member_ids=ids,
            reduced=matrix,
            umap_ms=0.0,
            hdbscan_ms=0.0,
        )

    umap_start = time.perf_counter()
    reducer = umap.UMAP(
        n_components=min(UMAP_N_COMPONENTS, max(2, n - 2)),
        n_neighbors=min(UMAP_N_NEIGHBORS, max(2, n - 1)),
        min_dist=UMAP_MIN_DIST,
        metric="cosine",
        random_state=UMAP_RANDOM_STATE,
    )
    if n > UMAP_FIT_SAMPLE_SIZE:
        # Sample-fit then assign: learn the manifold on a seeded sample, then
        # project every vector (including the sample) onto it. Deterministic —
        # seeded sample indices + seeded fit + a pure transform.
        sample_rng = np.random.default_rng(UMAP_RANDOM_STATE)
        sample_idx = sample_rng.choice(n, size=UMAP_FIT_SAMPLE_SIZE, replace=False)
        reducer.fit(matrix[sample_idx])
        reduced = reducer.transform(matrix)
    else:
        reduced = reducer.fit_transform(matrix)
    umap_ms = (time.perf_counter() - umap_start) * 1000

    hdbscan_start = time.perf_counter()
    clusterer = hdbscan.HDBSCAN(min_cluster_size=effective_min_cluster_size)
    labels = clusterer.fit_predict(reduced)
    hdbscan_ms = (time.perf_counter() - hdbscan_start) * 1000

    return ClusteringResult(
        labels=labels,
        member_ids=ids,
        reduced=reduced,
        umap_ms=umap_ms,
        hdbscan_ms=hdbscan_ms,
    )


def group_by_cluster(result: ClusteringResult) -> dict:
    groups: dict = {}
    noise: List[str] = []
    for member_id, label in zip(result.member_ids, result.labels):
        if label == NOISE_LABEL:
            noise.append(member_id)
            continue
        groups.setdefault(int(label), []).append(member_id)
    return {"groups": groups, "noise": noise}
