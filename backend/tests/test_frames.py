def test_list_frames_empty(client):
    # Initially, we expect no frames to be present
    response = client.get("/api/frames")
    assert response.status_code == 200
    data = response.json()
    assert "frames" in data
    assert data["frames"] == []

def test_create_and_list_frames(client):
    # Create a new frame
    frame_data = {
        "name": "Test Frame",
        "frame_host": "localhost",
        "server_host": "localhost"
    }
    response = client.post("/api/frames/new", json=frame_data)
    assert response.status_code == 200
    data = response.json()
    assert "frame" in data
    frame_id = data["frame"]["id"]

    # Now list frames again
    response = client.get("/api/frames")
    assert response.status_code == 200
    data = response.json()
    assert len(data["frames"]) == 1
    assert data["frames"][0]["id"] == frame_id
    assert data["frames"][0]["name"] == "Test Frame"

def test_get_frame_by_id(client):
    # Create a frame
    frame_data = {
        "name": "Another Frame",
        "frame_host": "localhost",
        "server_host": "localhost"
    }
    response = client.post("/api/frames/new", json=frame_data)
    assert response.status_code == 200
    data = response.json()
    frame_id = data["frame"]["id"]

    # Get it by ID
    response = client.get(f"/api/frames/{frame_id}")
    assert response.status_code == 200
    data = response.json()
    assert "frame" in data
    assert data["frame"]["id"] == frame_id
    assert data["frame"]["name"] == "Another Frame"

def test_get_frame_not_found(client):
    # Try to get a non-existent frame
    response = client.get("/api/frames/999999")
    assert response.status_code == 404
