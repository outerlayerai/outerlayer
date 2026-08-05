from typing import List

from pydantic import BaseModel, Field

# Request contract (parsed directly with orjson in main.py, not via Pydantic, to
# avoid per-float validation of the ~51M floats in a 50k×1024 payload):
#   {
#     "embeddings": [{"id": str, "vector": [float, ...]}, ...],
#     "options": {"minClusterSize": int}?   # optional
#   }
# Responses stay on Pydantic — they're tiny (ids only, no vectors) so validation
# cost is negligible and the alias handling below is worth keeping.


class Cluster(BaseModel):
    id: str
    name: str
    description: str
    member_ids: List[str] = Field(serialization_alias="memberIds")

    class Config:
        populate_by_name = True


class ClusterResponse(BaseModel):
    clusters: List[Cluster]
    noise: List[str]
    generation_ms: float = Field(serialization_alias="generationMs")

    class Config:
        populate_by_name = True


class HealthResponse(BaseModel):
    status: str
