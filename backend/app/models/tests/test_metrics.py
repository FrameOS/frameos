from datetime import datetime, timedelta
from unittest.mock import patch, AsyncMock

import pytest
from app.models.frame import new_frame
from app.models.metrics import METRICS_RETAINED_PER_FRAME, Metrics, new_metrics

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
    assert metric_entry.to_dict()["timestamp"].endswith("+00:00")
    published_payload = mock_pub.await_args.args[2]
    assert published_payload["timestamp"].endswith("+00:00")

@pytest.mark.asyncio
@patch("app.models.metrics.publish_message", new_callable=AsyncMock)
async def test_new_metrics_trimming(mock_pub, db, redis):
    frame = await new_frame(db, redis, "MetricsTrimFrame", "localhost", "server_host")
    db.query(Metrics).delete()
    db.commit()

    base_timestamp = datetime(2026, 1, 1)
    db.add_all(
        [
            Metrics(
                project_id=frame.project_id,
                frame_id=frame.id,
                metrics={"index": i},
                timestamp=base_timestamp + timedelta(seconds=i),
            )
            for i in range(METRICS_RETAINED_PER_FRAME)
        ]
    )
    db.commit()

    await new_metrics(db, redis, frame.id, {"index": METRICS_RETAINED_PER_FRAME})
    count = db.query(Metrics).filter_by(frame_id=frame.id).count()
    assert count == METRICS_RETAINED_PER_FRAME
