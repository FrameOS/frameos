const std = @import("std");

const CliOptions = struct {
    scene_id: []const u8,
    out_path: []const u8,
    snapshots_dir: []const u8,
};

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const options = parseArgs(allocator) catch |err| switch (err) {
        error.InvalidArgs => {
            printUsage();
            std.process.exit(1);
        },
        else => return err,
    };

    try renderScene(options, allocator);
}

fn printUsage() void {
    std.debug.print(
        "Usage: scene_renderer --scene <scene_id> --out <output_png> [--snapshots-dir <path>]\n",
        .{},
    );
}

fn parseArgs(allocator: std.mem.Allocator) !CliOptions {
    var args = try std.process.argsWithAllocator(allocator);
    defer args.deinit();

    _ = args.next(); // executable name

    var scene_id: ?[]const u8 = null;
    var out_path: ?[]const u8 = null;
    var snapshots_dir: []const u8 = "./snapshots";

    while (args.next()) |arg| {
        if (std.mem.eql(u8, arg, "--scene")) {
            scene_id = args.next() orelse return error.InvalidArgs;
        } else if (std.mem.eql(u8, arg, "--out")) {
            out_path = args.next() orelse return error.InvalidArgs;
        } else if (std.mem.eql(u8, arg, "--snapshots-dir")) {
            snapshots_dir = args.next() orelse return error.InvalidArgs;
        } else {
            return error.InvalidArgs;
        }
    }

    return .{
        .scene_id = scene_id orelse return error.InvalidArgs,
        .out_path = out_path orelse return error.InvalidArgs,
        .snapshots_dir = snapshots_dir,
    };
}

fn renderScene(options: CliOptions, allocator: std.mem.Allocator) !void {
    const source_path = try std.fmt.allocPrint(allocator, "{s}/{s}.png", .{ options.snapshots_dir, options.scene_id });
    defer allocator.free(source_path);

    try copyFile(source_path, options.out_path);
}

fn copyFile(source_path: []const u8, dest_path: []const u8) !void {
    var source = try std.fs.cwd().openFile(source_path, .{});
    defer source.close();

    if (std.fs.path.dirname(dest_path)) |dirname| {
        try std.fs.cwd().makePath(dirname);
    }

    var dest = try std.fs.cwd().createFile(dest_path, .{ .truncate = true });
    defer dest.close();

    var buf: [8192]u8 = undefined;
    while (true) {
        const bytes_read = try source.read(&buf);
        if (bytes_read == 0) break;
        try dest.writeAll(buf[0..bytes_read]);
    }
}
