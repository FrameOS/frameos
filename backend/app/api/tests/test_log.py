import pytest
from app.models import new_frame, update_frame, Log

@pytest.fixture
async def frame_with_key(db_session):
    frame = await new_frame(db_session, 'Frame', 'localhost', 'localhost')
    frame.server_api_key = 'testkey'
    await update_frame(db_session, frame)
    # Ensure no non-welcome logs
    assert db_session.query(Log).filter_by(frame=frame).filter(Log.type != 'welcome').count() == 0
    return frame

@pytest.mark.asyncio
async def test_api_log_single_entry(async_client, db_session, frame_with_key):
    headers = {'Authorization': 'Bearer testkey'}
    data = {'log': {'event': 'log', 'message': 'banana'}}
    response = await async_client.post('/api/log', json=data, headers=headers)
    assert response.status_code == 200
    assert db_session.query(Log).filter_by(frame=frame_with_key).filter(Log.type != 'welcome').count() == 1

@pytest.mark.asyncio
async def test_api_log_multiple_entries(async_client, db_session, frame_with_key):
    headers = {'Authorization': 'Bearer testkey'}
    logs = [{'event': 'log', 'message': 'banana'}, {'event': 'log', 'message': 'pineapple'}]
    data = {'logs': logs}
    response = await async_client.post('/api/log', json=data, headers=headers)
    assert response.status_code == 200
    assert db_session.query(Log).filter_by(frame=frame_with_key).filter(Log.type != 'welcome').count() == 2

@pytest.mark.asyncio
async def test_api_log_no_data(async_client, db_session, frame_with_key):
    headers = {'Authorization': 'Bearer testkey'}
    response = await async_client.post('/api/log', json={}, headers=headers)
    assert response.status_code == 200

@pytest.mark.asyncio
async def test_api_log_bad_key(async_client, db_session, frame_with_key):
    headers = {'Authorization': 'Bearer wasabi'}
    data = {'log': {'event': 'log', 'message': 'banana'}}
    response = await async_client.post('/api/log', json=data, headers=headers)
    assert response.status_code == 401

@pytest.mark.asyncio
async def test_api_log_no_key(async_client, db_session, frame_with_key):
    data = {'log': {'event': 'log', 'message': 'banana'}}
    response = await async_client.post('/api/log', json=data)
    assert response.status_code == 401
    assert db_session.query(Log).filter_by(frame=frame_with_key).filter(Log.type != 'welcome').count() == 0

@pytest.mark.asyncio
async def test_api_log_limits(async_client, db_session, frame_with_key):
    # Clear existing logs
    for old_log in db_session.query(Log).all():
        db_session.delete(old_log)
    db_session.commit()

    headers = {'Authorization': 'Bearer testkey'}
    data = {'logs': [{'event': 'log', 'message': 'banana'}] * 1200}
    response = await async_client.post('/api/log', json=data, headers=headers)
    assert response.status_code == 200
    assert db_session.query(Log).filter_by(frame=frame_with_key).count() == 1100

    data = {'logs': [{'event': 'log', 'message': 'banana'}] * 50}
    await async_client.post('/api/log', json=data, headers=headers)
    assert db_session.query(Log).filter_by(frame=frame_with_key).count() == 1050

    data = {'logs': [{'event': 'log', 'message': 'banana'}] * 40}
    await async_client.post('/api/log', json=data, headers=headers)
    assert db_session.query(Log).filter_by(frame=frame_with_key).count() == 1090

    data = {'logs': [{'event': 'log', 'message': 'banana'}] * 30}
    await async_client.post('/api/log', json=data, headers=headers)
    assert db_session.query(Log).filter_by(frame=frame_with_key).count() == 1020
