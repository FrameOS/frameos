const std = @import("std");
const frameos = @import("frameos.zig");

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);

    if (args.len > 1 and std.mem.eql(u8, args[1], "check")) {
        const stdout = std.io.getStdOut().writer();
        try stdout.print("FrameOS check: passed 🎉\n", .{});
        return;
    }

    try frameos.startFrameOS();
}
