import pytest
from unittest.mock import patch, AsyncMock
from app.models.metrics import new_metrics, Metrics
from app.models.frame import new_frame

@pytest.mark.asyncio
@patch("app.models.metrics.publish_message", new_callable=AsyncMock)
async def test_new_metrics(mock_pub, db, redis):
    frame = await new_frame(db, redis, "MetricsFrame", "localhost", "server_host")
    assert mock_pub.await_count == 0
    metric_entry = await new_metrics(db, redis, frame.id, {"cpu": 50, "ram": "1GB"})
    assert mock_pub.await_count == 1
    assert metric_entry.id is not None
    assert "cpu" in metric_entry.metrics
    assert metric_entry.metrics["cpu"] == 50

@pytest.mark.asyncio
@patch("app.models.metrics.publish_message", new_callable=AsyncMock)
async def test_new_metrics_trimming(mock_pub, db, redis):
    frame = await new_frame(db, redis, "MetricsTrimFrame", "localhost", "server_host")
    db.query(Metrics).delete()
    db.commit()

    for i in range(1200):
        await new_metrics(db, redis, frame.id, {"index": i})
    count = db.query(Metrics).filter_by(frame_id=frame.id).count()
    assert count == 1100
