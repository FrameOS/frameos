import pytest
from app.models import new_frame, update_frame, Log

@pytest.mark.asyncio
async def test_api_log_single_entry(async_client, db_session, redis):
    # Create a frame with server_api_key
    frame = await new_frame(db_session, redis, 'LogFrame', 'localhost', 'localhost')
    frame.server_api_key = 'testkey'
    await update_frame(db_session, redis, frame)

    headers = {'Authorization': 'Bearer testkey'}
    data = {'log': {'event': 'log', 'message': 'banana'}}
    response = await async_client.post('/api/log', json=data, headers=headers)
    assert response.status_code == 200
    # Check the DB
    logs = db_session.query(Log).filter_by(frame_id=frame.id).all()
    # We have the welcome log plus the new one
    assert len(logs) == 2
    assert "banana" in logs[1].line

@pytest.mark.asyncio
async def test_api_log_multiple_entries(async_client, db_session, redis):
    frame = await new_frame(db_session, redis, 'MultiLogFrame', 'localhost', 'localhost')
    frame.server_api_key = 'testkey'
    await update_frame(db_session, redis, frame)

    headers = {'Authorization': 'Bearer testkey'}
    data = {
        'logs': [
            {'event': 'log', 'message': 'banana'},
            {'event': 'log', 'message': 'pineapple'}
        ]
    }
    response = await async_client.post('/api/log', json=data, headers=headers)
    assert response.status_code == 200
    logs = db_session.query(Log).filter_by(frame_id=frame.id).all()
    # 1 welcome + 2 new
    assert len(logs) == 3

@pytest.mark.asyncio
async def test_api_log_no_data(async_client, db_session, redis):
    frame = await new_frame(db_session, redis, 'NoDataFrame', 'localhost', 'localhost')
    frame.server_api_key = 'testkey'
    await update_frame(db_session, redis, frame)

    headers = {'Authorization': 'Bearer testkey'}
    response = await async_client.post('/api/log', json={}, headers=headers)
    assert response.status_code == 200

@pytest.mark.asyncio
async def test_api_log_bad_key(async_client, db_session, redis):
    frame = await new_frame(db_session, redis, 'BadKeyFrame', 'localhost', 'localhost')
    frame.server_api_key = 'goodkey'
    await update_frame(db_session, redis, frame)

    headers = {'Authorization': 'Bearer wrongkey'}
    data = {'log': {'event': 'log', 'message': 'banana'}}
    response = await async_client.post('/api/log', json=data, headers=headers)
    assert response.status_code == 401
    assert response.json()['detail'] == "Unauthorized"

@pytest.mark.asyncio
async def test_api_log_no_key(async_client, db_session, redis):
    frame = await new_frame(db_session, redis, 'NoKeyFrame', 'localhost', 'localhost')
    frame.server_api_key = 'somekey'
    await update_frame(db_session, redis, frame)

    data = {'log': {'event': 'log', 'message': 'banana'}}
    response = await async_client.post('/api/log', json=data)
    assert response.status_code == 401
    assert response.json()['detail'] == "Unauthorized"
