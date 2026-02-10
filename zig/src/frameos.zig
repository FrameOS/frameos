const std = @import("std");

pub fn startFrameOS() !void {
    const stdout = std.io.getStdOut().writer();
    try stdout.print(
        "FrameOS Zig stub booting (config/logger/driver init TBD)...\n",
        .{},
    );

    while (true) {
        std.time.sleep(1 * std.time.ns_per_s);
    }
}
