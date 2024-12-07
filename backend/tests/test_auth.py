import pytest
from sqlalchemy.orm import Session
from app.models.user import User, pwd_context

def create_user(db: Session, email: str, password: str):
    user = User(email=email, password=pwd_context.hash(password))
    db.add(user)
    db.commit()
    db.refresh(user)
    return user

def test_signup_successful(client, db_session):
    response = client.post("/api/auth/signup", json={
        "email": "test@example.com",
        "password": "password123",
        "password2": "password123"
    })
    assert response.status_code == 201
    data = response.json()
    assert data["email"] == "test@example.com"

    user = db_session.query(User).filter_by(email="test@example.com").first()
    assert user is not None
    assert user.verify_password("password123")

def test_signup_with_password_mismatch(client, db_session):
    response = client.post("/api/auth/signup", json={
        "email": "test2@example.com",
        "password": "password123",
        "password2": "differentpassword"
    })
    assert response.status_code == 400
    data = response.json()
    assert data["detail"] == "Passwords do not match."

def test_signup_only_one_user(client, db_session):
    # Create one user first
    create_user(db_session, "existing@example.com", "password123")

    response = client.post("/api/auth/signup", json={
        "email": "second@example.com",
        "password": "password123",
        "password2": "password123"
    })
    assert response.status_code == 400
    data = response.json()
    assert data["detail"] == "User already exists. Please login."

def test_signup_invalid_input(client):
    # Missing fields
    response = client.post("/api/auth/signup", json={})
    # The code throws 422 by default due to Pydantic validation error on required fields
    assert response.status_code == 422

def test_login_valid(client, db_session):
    create_user(db_session, "me@test.com", "banana")
    response = client.post("/api/auth/login", json={"email": "me@test.com", "password": "banana"})
    assert response.status_code == 200
    data = response.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"

def test_login_invalid_user(client, db_session):
    # No user in DB
    response = client.post("/api/auth/login", json={"email": "notfound@test.com", "password": "banana"})
    assert response.status_code == 401
    data = response.json()
    assert data["detail"] == "Invalid email or password"

def test_login_invalid_password(client, db_session):
    create_user(db_session, "me@test.com", "banana")
    response = client.post("/api/auth/login", json={"email": "me@test.com", "password": "wrongpass"})
    assert response.status_code == 401
    data = response.json()
    assert data["detail"] == "Invalid email or password"

@pytest.fixture
def authenticated_client(client, db_session):
    create_user(db_session, "me@test.com", "banana")
    response = client.post("/api/auth/login", json={"email": "me@test.com", "password": "banana"})
    token = response.json()["access_token"]
    # Return a client with Authorization header set
    client.headers.update({"Authorization": f"Bearer {token}"})
    return client

def test_protected_route_unauthorized(client):
    # Attempt to get frames without auth
    response = client.get("/api/frames")
    assert response.status_code == 401
    data = response.json()
    assert data["detail"] == "Could not validate credentials"

def test_protected_route_authorized(authenticated_client):
    # Attempt to get frames with valid auth
    response = authenticated_client.get("/api/frames")
    assert response.status_code == 200
    data = response.json()
    # If no frames are created, it should return an empty list
    assert data == {"frames": []}

def test_logout(client):
    # With JWT auth, "logout" doesn’t invalidate the token server-side by default.
    # This test just ensures that the endpoint works (it should return success).
    response = client.post("/api/auth/logout")
    assert response.status_code == 200
    data = response.json()
    assert data == {"success": True}
