const std = @import("std");

const image_width = 320;
const image_height = 480;

const CliOptions = struct {
    scene_id: []const u8,
    out_path: []const u8,
    scenes_dir: []const u8,
};

const Color = struct {
    r: u8,
    g: u8,
    b: u8,
};

const RenderPlan = union(enum) {
    solid: Color,
    gradient: struct {
        start: Color,
        end: Color,
    },
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

    renderScene(options, allocator) catch |err| switch (err) {
        error.UnsupportedScene => {
            std.log.warn("scene '{s}' not yet supported by Zig renderer; allow reference fallback", .{options.scene_id});
            std.process.exit(2);
        },
        else => return err,
    };
}

fn printUsage() void {
    std.debug.print(
        "Usage: scene_renderer --scene <scene_id> --out <output_png> [--scenes-dir <path>]\n",
        .{},
    );
}

fn parseArgs(allocator: std.mem.Allocator) !CliOptions {
    var args = try std.process.argsWithAllocator(allocator);
    defer args.deinit();

    _ = args.next(); // executable name

    var scene_id: ?[]const u8 = null;
    var out_path: ?[]const u8 = null;
    var scenes_dir: []const u8 = "./scenes";

    while (args.next()) |arg| {
        if (std.mem.eql(u8, arg, "--scene")) {
            scene_id = args.next() orelse return error.InvalidArgs;
        } else if (std.mem.eql(u8, arg, "--out")) {
            out_path = args.next() orelse return error.InvalidArgs;
        } else if (std.mem.eql(u8, arg, "--scenes-dir")) {
            scenes_dir = args.next() orelse return error.InvalidArgs;
        } else {
            return error.InvalidArgs;
        }
    }

    return .{
        .scene_id = scene_id orelse return error.InvalidArgs,
        .out_path = out_path orelse return error.InvalidArgs,
        .scenes_dir = scenes_dir,
    };
}

fn renderScene(options: CliOptions, allocator: std.mem.Allocator) !void {
    const scene_path = try std.fmt.allocPrint(allocator, "{s}/{s}.json", .{ options.scenes_dir, options.scene_id });
    defer allocator.free(scene_path);

    const source = try std.fs.cwd().readFileAlloc(allocator, scene_path, 1024 * 1024);
    defer allocator.free(source);

    const plan = try buildRenderPlan(source, options.scene_id);

    if (std.fs.path.dirname(options.out_path)) |dirname| {
        try std.fs.cwd().makePath(dirname);
    }

    var file = try std.fs.cwd().createFile(options.out_path, .{ .truncate = true });
    defer file.close();

    try writeImageAsPng(file.writer(), allocator, plan);
}

fn buildRenderPlan(scene_json: []const u8, scene_id: []const u8) !RenderPlan {
    _ = scene_id;
    var parsed = try std.json.parseFromSlice(std.json.Value, std.heap.page_allocator, scene_json, .{});
    defer parsed.deinit();

    const root = parsed.value;
    const root_obj = root.object;

    var background = Color{ .r = 0, .g = 0, .b = 0 };
    if (root_obj.get("settings")) |settings_value| {
        if (settings_value.object.get("backgroundColor")) |bg| {
            if (bg == .string) {
                background = try parseHexColor(bg.string);
            }
        }
    }

    const nodes_value = root_obj.get("nodes") orelse return error.UnsupportedScene;
    if (nodes_value != .array) return error.UnsupportedScene;

    var keywords = std.BoundedArray([]const u8, 8){};
    var color_node: ?Color = null;
    var gradient_start: ?Color = null;
    var gradient_end: ?Color = null;

    for (nodes_value.array.items) |node_value| {
        if (node_value != .object) continue;
        const data_value = node_value.object.get("data") orelse continue;
        if (data_value != .object) continue;

        const keyword_value = data_value.object.get("keyword") orelse continue;
        if (keyword_value != .string) continue;

        const keyword = keyword_value.string;
        if (keywords.len < keywords.capacity()) {
            try keywords.append(keyword);
        }

        if (std.mem.eql(u8, keyword, "render/color")) {
            const config = data_value.object.get("config") orelse continue;
            if (config == .object and config.object.get("color")) |color| {
                if (color == .string) {
                    color_node = try parseHexColor(color.string);
                }
            }
        }

        if (std.mem.eql(u8, keyword, "render/gradient")) {
            const config = data_value.object.get("config") orelse continue;
            if (config != .object) continue;
            if (config.object.get("startColor")) |start| {
                if (start == .string) gradient_start = try parseHexColor(start.string);
            }
            if (config.object.get("endColor")) |finish| {
                if (finish == .string) gradient_end = try parseHexColor(finish.string);
            }
        }
    }

    if (onlyKeywords(&keywords, &[_][]const u8{"render"})) {
        return .{ .solid = background };
    }

    if (onlyKeywords(&keywords, &[_][]const u8{ "render", "render/color" })) {
        return .{ .solid = color_node orelse background };
    }

    // Current support is intentionally narrow: full-screen gradient scene routed through render/image.
    if (onlyKeywords(&keywords, &[_][]const u8{ "render", "render/gradient", "render/image" })) {
        if (gradient_start) |start| {
            if (gradient_end) |finish| {
                return .{ .gradient = .{ .start = start, .end = finish } };
            }
        }
    }

    return error.UnsupportedScene;
}

fn onlyKeywords(found: *const std.BoundedArray([]const u8, 8), expected: []const []const u8) bool {
    var seen = std.StaticBitSet(8).initEmpty();

    for (found.constSlice()) |keyword| {
        var matched = false;
        for (expected, 0..) |candidate, i| {
            if (std.mem.eql(u8, keyword, candidate)) {
                seen.set(i);
                matched = true;
                break;
            }
        }
        if (!matched) return false;
    }

    return seen.count() == expected.len;
}

fn parseHexColor(input: []const u8) !Color {
    if (input.len != 7 or input[0] != '#') return error.InvalidColor;
    const r = try std.fmt.parseInt(u8, input[1..3], 16);
    const g = try std.fmt.parseInt(u8, input[3..5], 16);
    const b = try std.fmt.parseInt(u8, input[5..7], 16);
    return .{ .r = r, .g = g, .b = b };
}

fn writeImageAsPng(writer: anytype, allocator: std.mem.Allocator, plan: RenderPlan) !void {
    var raw = std.ArrayList(u8).init(allocator);
    defer raw.deinit();

    try raw.ensureTotalCapacity((image_width * 4 + 1) * image_height);

    for (0..image_height) |y| {
        try raw.append(0); // filter: none

        for (0..image_width) |x| {
            const color = switch (plan) {
                .solid => |solid| solid,
                .gradient => |gradient| interpolateGradient(gradient.start, gradient.end, x, y),
            };

            try raw.append(color.r);
            try raw.append(color.g);
            try raw.append(color.b);
            try raw.append(255);
        }
    }

    var compressed = std.ArrayList(u8).init(allocator);
    defer compressed.deinit();

    {
        var compressor = try std.compress.zlib.compressor(compressed.writer(), .{});
        try compressor.writer().writeAll(raw.items);
        try compressor.finish();
    }

    try writer.writeAll("\x89PNG\r\n\x1a\n");

    var ihdr: [13]u8 = undefined;
    std.mem.writeInt(u32, ihdr[0..4], image_width, .big);
    std.mem.writeInt(u32, ihdr[4..8], image_height, .big);
    ihdr[8] = 8;
    ihdr[9] = 6; // rgba
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    try writeChunk(writer, "IHDR", &ihdr);
    try writeChunk(writer, "IDAT", compressed.items);
    try writeChunk(writer, "IEND", "");
}

fn interpolateGradient(start: Color, finish: Color, x: usize, y: usize) Color {
    const denominator = @as(f32, @floatFromInt((image_width - 1) + (image_height - 1)));
    const progress = @as(f32, @floatFromInt(x + y)) / denominator;

    return .{
        .r = lerpComponent(start.r, finish.r, progress),
        .g = lerpComponent(start.g, finish.g, progress),
        .b = lerpComponent(start.b, finish.b, progress),
    };
}

fn lerpComponent(a: u8, b: u8, t: f32) u8 {
    const af = @as(f32, @floatFromInt(a));
    const bf = @as(f32, @floatFromInt(b));
    const value = af + (bf - af) * t;
    return @intFromFloat(@round(value));
}

fn writeChunk(writer: anytype, tag: []const u8, payload: []const u8) !void {
    var length_buf: [4]u8 = undefined;
    std.mem.writeInt(u32, &length_buf, @intCast(payload.len), .big);
    try writer.writeAll(&length_buf);
    try writer.writeAll(tag);
    try writer.writeAll(payload);

    var crc = std.hash.Crc32.init();
    crc.update(tag);
    crc.update(payload);

    var crc_buf: [4]u8 = undefined;
    std.mem.writeInt(u32, &crc_buf, crc.final(), .big);
    try writer.writeAll(&crc_buf);
}

test "parseHexColor parses rgb hex" {
    const parsed = try parseHexColor("#1a2B3c");
    try std.testing.expectEqual(@as(u8, 0x1a), parsed.r);
    try std.testing.expectEqual(@as(u8, 0x2b), parsed.g);
    try std.testing.expectEqual(@as(u8, 0x3c), parsed.b);
}

test "buildRenderPlan supports full-screen color scene" {
    const scene =
        \\\{
        \\\  "settings": {"backgroundColor": "#000000"},
        \\\  "nodes": [
        \\\    {"data": {"keyword": "render"}},
        \\\    {"data": {"keyword": "render/color", "config": {"color": "#525dff"}}}
        \\\  ]
        \\\}
    ;

    const plan = try buildRenderPlan(scene, "renderColorFlow");
    switch (plan) {
        .solid => |solid| {
            try std.testing.expectEqual(@as(u8, 0x52), solid.r);
            try std.testing.expectEqual(@as(u8, 0x5d), solid.g);
            try std.testing.expectEqual(@as(u8, 0xff), solid.b);
        },
        else => return error.TestExpectedEqual,
    }
}

test "buildRenderPlan rejects unsupported mixes" {
    const scene =
        \\\{
        \\\  "nodes": [
        \\\    {"data": {"keyword": "render"}},
        \\\    {"data": {"keyword": "render/color", "config": {"color": "#ffffff"}}},
        \\\    {"data": {"keyword": "render/split", "config": {"rows": "2"}}}
        \\\  ]
        \\\}
    ;

    try std.testing.expectError(error.UnsupportedScene, buildRenderPlan(scene, "renderSplitFlow"));
}
