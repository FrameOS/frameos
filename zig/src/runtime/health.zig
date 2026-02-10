const logger_mod = @import("logger.zig");

pub const StartupState = enum {
    booting,
    degraded_network,
    ready,
};

pub const HealthSnapshot = struct {
    status: Status,
    startup_state: StartupState,
    server_started: bool,
    network_required: bool,
    network_ok: ?bool,
    scheduler_ready: bool,
    runner_ready: bool,

    pub const Status = enum {
        ok,
        degraded,
    };
};

pub const RuntimeHealth = struct {
    logger: logger_mod.RuntimeLogger,
    startup_state: StartupState,
    server_started: bool,
    network_required: bool,
    network_ok: ?bool,
    scheduler_ready: bool,
    runner_ready: bool,

    pub fn init(logger: logger_mod.RuntimeLogger, network_required: bool, startup_state: StartupState) RuntimeHealth {
        return .{
            .logger = logger,
            .startup_state = startup_state,
            .server_started = false,
            .network_required = network_required,
            .network_ok = null,
            .scheduler_ready = false,
            .runner_ready = false,
        };
    }

    pub fn markServerStarted(self: *RuntimeHealth) void {
        self.server_started = true;
        self.reconcileStartupState();
    }

    pub fn recordNetworkProbe(self: *RuntimeHealth, ok: bool) void {
        self.network_ok = ok;
        self.reconcileStartupState();
    }

    pub fn markSchedulerReady(self: *RuntimeHealth) void {
        self.scheduler_ready = true;
        self.reconcileStartupState();
    }

    pub fn markRunnerReady(self: *RuntimeHealth) void {
        self.runner_ready = true;
        self.reconcileStartupState();
    }

    pub fn startup(self: RuntimeHealth) !void {
        const snapshot = self.snapshot();
        try self.logger.info(
            "{\"event\":\"health.start\",\"status\":\"{s}\",\"startupState\":\"{s}\",\"serverStarted\":{},\"networkRequired\":{},\"networkOk\":{s},\"schedulerReady\":{},\"runnerReady\":{}}",
            .{
                statusLabel(snapshot.status),
                startupStateLabel(snapshot.startup_state),
                snapshot.server_started,
                snapshot.network_required,
                networkLabel(snapshot.network_ok),
                snapshot.scheduler_ready,
                snapshot.runner_ready,
            },
        );
    }

    pub fn snapshot(self: RuntimeHealth) HealthSnapshot {
        return .{
            .status = if (self.isReady()) .ok else .degraded,
            .startup_state = self.startup_state,
            .server_started = self.server_started,
            .network_required = self.network_required,
            .network_ok = self.network_ok,
            .scheduler_ready = self.scheduler_ready,
            .runner_ready = self.runner_ready,
        };
    }

    fn isReady(self: RuntimeHealth) bool {
        return self.server_started and
            self.scheduler_ready and
            self.runner_ready and
            (!self.network_required or self.network_ok == true);
    }

    fn reconcileStartupState(self: *RuntimeHealth) void {
        if (self.network_required and self.network_ok == false) {
            self.startup_state = .degraded_network;
            return;
        }

        if (self.isReady()) {
            self.startup_state = .ready;
        }
    }
};

fn statusLabel(status: HealthSnapshot.Status) []const u8 {
    return switch (status) {
        .ok => "ok",
        .degraded => "degraded",
    };
}

pub fn startupStateLabel(state: StartupState) []const u8 {
    return switch (state) {
        .booting => "booting",
        .degraded_network => "degraded-network",
        .ready => "ready",
    };
}

fn networkLabel(network_ok: ?bool) []const u8 {
    return if (network_ok) |is_ok|
        if (is_ok) "true" else "false"
    else
        "unknown";
}

test "snapshot is degraded before server startup" {
    const testing = @import("std").testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = true,
        .device = "simulator",
        .startup_scene = "clock",
    });

    const health = RuntimeHealth.init(logger, true, .booting);
    const snapshot = health.snapshot();

    try testing.expectEqual(HealthSnapshot.Status.degraded, snapshot.status);
    try testing.expectEqual(StartupState.booting, snapshot.startup_state);
    try testing.expect(!snapshot.server_started);
    try testing.expectEqual(@as(?bool, null), snapshot.network_ok);
    try testing.expect(!snapshot.scheduler_ready);
    try testing.expect(!snapshot.runner_ready);
}

test "snapshot progresses startup state from booting to ready once readiness passes" {
    const testing = @import("std").testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = true,
        .device = "simulator",
        .startup_scene = "clock",
    });

    var health = RuntimeHealth.init(logger, true, .booting);
    health.markServerStarted();
    health.markSchedulerReady();
    health.markRunnerReady();
    health.recordNetworkProbe(true);

    const snapshot = health.snapshot();

    try testing.expectEqual(HealthSnapshot.Status.ok, snapshot.status);
    try testing.expectEqual(StartupState.ready, snapshot.startup_state);
    try testing.expect(snapshot.server_started);
    try testing.expect(snapshot.scheduler_ready);
    try testing.expect(snapshot.runner_ready);
    try testing.expectEqual(@as(?bool, true), snapshot.network_ok);
}

test "snapshot can be ok without network requirement while keeping degraded state" {
    const testing = @import("std").testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = false,
        .device = "simulator",
        .startup_scene = "clock",
    });

    var health = RuntimeHealth.init(logger, false, .degraded_network);
    health.markServerStarted();
    health.markSchedulerReady();
    health.markRunnerReady();

    const snapshot = health.snapshot();

    try testing.expectEqual(HealthSnapshot.Status.ok, snapshot.status);
    try testing.expectEqual(StartupState.degraded_network, snapshot.startup_state);
    try testing.expectEqual(@as(?bool, null), snapshot.network_ok);
    try testing.expect(snapshot.scheduler_ready);
    try testing.expect(snapshot.runner_ready);
}

test "startup state becomes degraded-network when network probe fails" {
    const testing = @import("std").testing;

    const logger = logger_mod.RuntimeLogger.init(.{
        .frame_host = "127.0.0.1",
        .frame_port = 8787,
        .debug = false,
        .metrics_interval_s = 60,
        .network_check = true,
        .device = "simulator",
        .startup_scene = "clock",
    });

    var health = RuntimeHealth.init(logger, true, .booting);
    health.markServerStarted();
    health.markSchedulerReady();
    health.markRunnerReady();
    health.recordNetworkProbe(false);

    const snapshot = health.snapshot();
    try testing.expectEqual(HealthSnapshot.Status.degraded, snapshot.status);
    try testing.expectEqual(StartupState.degraded_network, snapshot.startup_state);
    try testing.expectEqual(@as(?bool, false), snapshot.network_ok);
}
