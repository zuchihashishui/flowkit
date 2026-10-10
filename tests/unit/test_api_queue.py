"""Exercise real ASGI routes, validation and SQLite queue persistence."""
import pytest
from agent.db import crud


@pytest.fixture
async def request_body(database):
    project = await crud.create_project("Test project")
    video = await crud.create_video(project["id"], "Test video")
    scene = await crud.create_scene(video["id"], 1, "Test scene")
    return dict(type="GENERATE_IMAGE", project_id=project["id"], video_id=video["id"], scene_id=scene["id"], orientation="HORIZONTAL")


async def test_app_import_and_registered_routes(client):
    response = await client.get("/openapi.json")
    assert response.status_code == 200
    paths = response.json()["paths"]
    for path in ("/api/requests", "/api/chatgpt/queue", "/api/elevenlabs/preview"):
        assert path in paths


async def test_request_validation_and_not_found(client):
    assert (await client.post("/api/requests", json={"type": "GENERATE_IMAGE"})).status_code == 422
    assert (await client.get("/api/requests/missing")).status_code == 404
    response = await client.get("/api/requests/batch-status")
    assert response.json()["total"] == 0
    assert response.json()["all_succeeded"] is False


async def test_duplicate_submit_and_batch_idempotency(client, request_body):
    first = await client.post("/api/requests", json=request_body)
    assert first.status_code == 200
    assert (await client.post("/api/requests", json=request_body)).status_code == 409
    batch = await client.post("/api/requests/batch", json={"requests": [request_body, request_body]})
    assert batch.status_code == 200
    assert [r["id"] for r in batch.json()] == [first.json()["id"]] * 2
    assert len(await crud.list_requests()) == 1
    assert (await crud.get_video(request_body["video_id"]))["orientation"] == "HORIZONTAL"


async def test_batch_status_tracks_terminal_failure(client, request_body):
    row = (await client.post("/api/requests", json=request_body)).json()
    assert (await client.get("/api/requests/batch-status")).json()["done"] is False
    await crud.update_request(row["id"], status="FAILED", error_message="test failure")
    result = (await client.get("/api/requests/batch-status")).json()
    assert result["done"] is True
    assert result["failed"] == 1
    assert result["all_succeeded"] is False
    await crud.update_request(row["id"], status="COMPLETED")
    assert (await client.get("/api/requests/batch-status")).json()["all_succeeded"] is True


async def test_queue_priority_retry_time_exclusion_and_limit(database):
    video = await crud.create_request("GENERATE_VIDEO")
    image = await crud.create_request("GENERATE_IMAGE")
    character = await crud.create_request("GENERATE_CHARACTER_IMAGE")
    delayed = await crud.create_request("GENERATE_CHARACTER_IMAGE")
    await crud.update_request(delayed["id"], next_retry_at="2999-01-01T00:00:00Z")
    await crud.create_request("UPSCALE_VIDEO")
    rows = await crud.list_actionable_requests(exclude_ids={image["id"]}, limit=2)
    assert [r["id"] for r in rows] == [character["id"], video["id"]]


@pytest.mark.parametrize("kind,operation,expected", [("GENERATE_IMAGE", None, "FAILED"), ("GENERATE_VIDEO", None, "FAILED"), ("GENERATE_VIDEO", "saved-operation", "PENDING")])
async def test_stale_jobs_only_repoll_saved_operations(database, kind, operation, expected):
    row = await crud.create_request(kind)
    await crud.update_request(row["id"], status="PROCESSING", request_id=operation)
    await database.execute("UPDATE request SET updated_at='2000-01-01T00:00:00Z' WHERE id=?", (row["id"],))
    await database.commit()
    assert await crud.reset_stale_processing() == 1
    assert (await crud.get_request(row["id"]))["status"] == expected


@pytest.mark.parametrize("prompts", [[], ["  "], ["ok", ""], ["x"] * 201])
async def test_chatgpt_queue_rejects_invalid_prompts(client, prompts):
    assert (await client.post("/api/chatgpt/queue", json={"prompts": prompts})).status_code == 422


async def test_chatgpt_queue_roundtrip_and_busy_config(client, gateway):
    response = await client.post("/api/chatgpt/queue", json={"prompts": ["日本語", "second"], "model": " "})
    assert response.status_code == 200
    rows = (await client.get("/api/chatgpt/queue")).json()["jobs"]
    assert [r["prompt"] for r in rows] == ["日本語", "second"]
    assert all(r["model"] == "auto" for r in rows)
    gateway._inflight.add("running")
    assert (await client.post("/api/chatgpt/config", json={"workers": 1, "timeout_seconds": 180})).status_code == 409


async def test_elevenlabs_preview_and_missing_job(client):
    response = await client.post("/api/elevenlabs/preview", json={"text": "日本語。" * 100, "max_chunk_characters": 100})
    assert response.status_code == 200
    assert "".join(p["text"] for p in response.json()["chunks"]) == "日本語。" * 100
    assert (await client.post("/api/elevenlabs/preview", json={"text": "   "})).status_code == 422
    assert (await client.post("/api/elevenlabs/preview", json={"text": "ok", "max_chunk_characters": "100"})).status_code == 422
    assert (await client.get("/api/elevenlabs/jobs/missing")).status_code == 404
    assert (await client.post("/api/elevenlabs/probe")).status_code == 409
