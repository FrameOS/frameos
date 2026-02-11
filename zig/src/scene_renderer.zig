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

const Rect = struct {
    x: usize,
    y: usize,
    w: usize,
    h: usize,
};

const Image = struct {
    pixels: []u8,

    fn init(allocator: std.mem.Allocator, fill: Color) !Image {
        const buf = try allocator.alloc(u8, image_width * image_height * 4);
        var image = Image{ .pixels = buf };
        image.fillRect(.{ .x = 0, .y = 0, .w = image_width, .h = image_height }, fill);
        return image;
    }

    fn deinit(self: *Image, allocator: std.mem.Allocator) void {
        allocator.free(self.pixels);
    }

    fn fillRect(self: *Image, rect: Rect, color: Color) void {
        for (rect.y..rect.y + rect.h) |y| {
            for (rect.x..rect.x + rect.w) |x| {
                const idx = (y * image_width + x) * 4;
                self.pixels[idx] = color.r;
                self.pixels[idx + 1] = color.g;
                self.pixels[idx + 2] = color.b;
                self.pixels[idx + 3] = 255;
            }
        }
    }

    fn fillRectGradient(self: *Image, rect: Rect, start: Color, finish: Color) void {
        const denom = @as(f32, @floatFromInt((rect.w - 1) + (rect.h - 1)));
        for (rect.y..rect.y + rect.h) |y| {
            for (rect.x..rect.x + rect.w) |x| {
                const local_x = x - rect.x;
                const local_y = y - rect.y;
                const progress = if (denom == 0) 0 else @as(f32, @floatFromInt(local_x + local_y)) / denom;
                const color = Color{
                    .r = lerpComponent(start.r, finish.r, progress),
                    .g = lerpComponent(start.g, finish.g, progress),
                    .b = lerpComponent(start.b, finish.b, progress),
                };
                const idx = (y * image_width + x) * 4;
                self.pixels[idx] = color.r;
                self.pixels[idx + 1] = color.g;
                self.pixels[idx + 2] = color.b;
                self.pixels[idx + 3] = 255;
            }
        }
    }
};

const NodeRef = struct {
    id: []const u8,
    keyword: []const u8,
    config: ?std.json.Value,
};

const EdgeRef = struct {
    source: []const u8,
    source_handle: []const u8,
    target: []const u8,
    target_handle: []const u8,
};

const SceneGraph = struct {
    nodes: []NodeRef,
    edges: []EdgeRef,
    background: Color,

    fn deinit(self: SceneGraph, allocator: std.mem.Allocator) void {
        allocator.free(self.nodes);
        allocator.free(self.edges);
    }

    fn findNode(self: SceneGraph, id: []const u8) ?NodeRef {
        for (self.nodes) |node| {
            if (std.mem.eql(u8, node.id, id)) return node;
        }
        return null;
    }

    fn findRootRender(self: SceneGraph) ?NodeRef {
        for (self.nodes) |node| {
            if (std.mem.eql(u8, node.keyword, "render")) return node;
        }
        return null;
    }

    fn edgeFrom(self: SceneGraph, source: []const u8, source_handle: []const u8) ?EdgeRef {
        for (self.edges) |edge| {
            if (std.mem.eql(u8, edge.source, source) and std.mem.eql(u8, edge.source_handle, source_handle)) {
                return edge;
            }
        }
        return null;
    }

    fn incomingByTargetHandle(self: SceneGraph, target: []const u8, handle_suffix: []const u8) ?EdgeRef {
        for (self.edges) |edge| {
            if (!std.mem.eql(u8, edge.target, target)) continue;
            if (std.mem.endsWith(u8, edge.target_handle, handle_suffix)) return edge;
        }
        return null;
    }
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

    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, source, .{});
    defer parsed.deinit();

    const graph = try parseSceneGraph(allocator, parsed.value, options.scene_id);
    defer graph.deinit(allocator);

    var image = try Image.init(allocator, graph.background);
    defer image.deinit(allocator);

    const full_rect = Rect{ .x = 0, .y = 0, .w = image_width, .h = image_height };
    const root = graph.findRootRender() orelse return error.UnsupportedScene;
    if (graph.edgeFrom(root.id, "next")) |edge| {
        try renderNode(&image, graph, edge.target, full_rect);
    }

    if (std.fs.path.dirname(options.out_path)) |dirname| {
        try std.fs.cwd().makePath(dirname);
    }

    var file = try std.fs.cwd().createFile(options.out_path, .{ .truncate = true });
    defer file.close();

    try writeImageAsPng(file.writer(), allocator, image.pixels);
}

fn parseSceneGraph(allocator: std.mem.Allocator, root: std.json.Value, scene_id: []const u8) !SceneGraph {
    _ = scene_id;
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
    const edges_value = root_obj.get("edges") orelse return error.UnsupportedScene;
    if (nodes_value != .array or edges_value != .array) return error.UnsupportedScene;

    var nodes = try allocator.alloc(NodeRef, nodes_value.array.items.len);
    errdefer allocator.free(nodes);
    var node_count: usize = 0;
    for (nodes_value.array.items) |node_value| {
        if (node_value != .object) continue;
        const id_value = node_value.object.get("id") orelse continue;
        if (id_value != .string) continue;

        const data_value = node_value.object.get("data") orelse continue;
        if (data_value != .object) continue;
        const keyword_value = data_value.object.get("keyword") orelse continue;
        if (keyword_value != .string) continue;

        nodes[node_count] = .{
            .id = id_value.string,
            .keyword = keyword_value.string,
            .config = data_value.object.get("config"),
        };
        node_count += 1;
    }

    var edges = try allocator.alloc(EdgeRef, edges_value.array.items.len);
    errdefer allocator.free(edges);
    var edge_count: usize = 0;
    for (edges_value.array.items) |edge_value| {
        if (edge_value != .object) continue;
        const source = edge_value.object.get("source") orelse continue;
        const source_handle = edge_value.object.get("sourceHandle") orelse continue;
        const target = edge_value.object.get("target") orelse continue;
        const target_handle = edge_value.object.get("targetHandle") orelse continue;
        if (source != .string or source_handle != .string or target != .string or target_handle != .string) continue;

        edges[edge_count] = .{
            .source = source.string,
            .source_handle = source_handle.string,
            .target = target.string,
            .target_handle = target_handle.string,
        };
        edge_count += 1;
    }

    return .{
        .nodes = nodes[0..node_count],
        .edges = edges[0..edge_count],
        .background = background,
    };
}

fn renderNode(image: *Image, graph: SceneGraph, node_id: []const u8, rect: Rect) !void {
    const node = graph.findNode(node_id) orelse return error.UnsupportedScene;

    if (std.mem.eql(u8, node.keyword, "render/color")) {
        const color = if (node.config) |config| blk: {
            if (config != .object) break :blk graph.background;
            if (config.object.get("color")) |value| {
                if (value == .string) break :blk try parseHexColor(value.string);
            }
            break :blk graph.background;
        } else graph.background;
        image.fillRect(rect, color);
        return;
    }

    if (std.mem.eql(u8, node.keyword, "render/gradient")) {
        if (node.config == null or node.config.? != .object) return error.UnsupportedScene;
        const start = node.config.?.object.get("startColor") orelse return error.UnsupportedScene;
        const finish = node.config.?.object.get("endColor") orelse return error.UnsupportedScene;
        if (start != .string or finish != .string) return error.UnsupportedScene;
        image.fillRectGradient(rect, try parseHexColor(start.string), try parseHexColor(finish.string));
        return;
    }

    if (std.mem.eql(u8, node.keyword, "render/image")) {
        const input = graph.incomingByTargetHandle(node.id, "image") orelse graph.incomingByTargetHandle(node.id, "inputImage") orelse return error.UnsupportedScene;
        try renderNode(image, graph, input.source, rect);
        return;
    }

    if (std.mem.eql(u8, node.keyword, "render/split")) {
        if (node.config == null or node.config.? != .object) return error.UnsupportedScene;
        const config = node.config.?.object;
        const rows = try parsePositiveInt(getStringField(config, "rows") orelse return error.UnsupportedScene);
        const columns = try parsePositiveInt(getStringField(config, "columns") orelse return error.UnsupportedScene);
        const margin = try parseNonNegativeInt(getStringField(config, "margin") orelse "0");
        const gap = try parseNonNegativeInt(getStringField(config, "gap") orelse "0");
        const row_ratios = try parseRatios(config, "height_ratios", rows);
        defer std.heap.page_allocator.free(row_ratios);
        const col_ratios = try parseRatios(config, "width_ratios", columns);
        defer std.heap.page_allocator.free(col_ratios);

        const inner_w = rect.w -| (2 * margin);
        const inner_h = rect.h -| (2 * margin);
        const total_gap_w = if (columns > 0) (columns - 1) * gap else 0;
        const total_gap_h = if (rows > 0) (rows - 1) * gap else 0;
        const content_w = inner_w -| total_gap_w;
        const content_h = inner_h -| total_gap_h;

        for (0..rows) |r| {
            for (0..columns) |c| {
                const cell = Rect{
                    .x = rect.x + margin + splitStart(content_w, col_ratios, c) + c * gap,
                    .y = rect.y + margin + splitStart(content_h, row_ratios, r) + r * gap,
                    .w = splitSize(content_w, col_ratios, c),
                    .h = splitSize(content_h, row_ratios, r),
                };

                const handle = try std.fmt.allocPrint(std.heap.page_allocator, "field/render_functions[{d}][{d}]", .{ r + 1, c + 1 });
                defer std.heap.page_allocator.free(handle);

                if (graph.edgeFrom(node.id, handle)) |edge| {
                    try renderNode(image, graph, edge.target, cell);
                }
            }
        }
        return;
    }

    if (std.mem.eql(u8, node.keyword, "render")) {
        if (graph.edgeFrom(node.id, "next")) |edge| {
            return renderNode(image, graph, edge.target, rect);
        }
        return;
    }

    return error.UnsupportedScene;
}

fn getStringField(object: std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const value = object.get(key) orelse return null;
    if (value != .string) return null;
    return value.string;
}

fn parsePositiveInt(input: []const u8) !usize {
    const n = try std.fmt.parseInt(usize, input, 10);
    if (n == 0) return error.UnsupportedScene;
    return n;
}

fn parseNonNegativeInt(input: []const u8) !usize {
    return std.fmt.parseInt(usize, input, 10);
}

fn parseRatios(config: std.json.ObjectMap, field: []const u8, count: usize) ![]usize {
    const raw = getStringField(config, field) orelse return error.UnsupportedScene;
    var tokens = std.mem.tokenizeAny(u8, raw, " ");
    var ratios = try std.heap.page_allocator.alloc(usize, count);

    var i: usize = 0;
    while (tokens.next()) |token| {
        if (i >= count) return error.UnsupportedScene;
        const value = try std.fmt.parseInt(usize, token, 10);
        if (value == 0) return error.UnsupportedScene;
        ratios[i] = value;
        i += 1;
    }
    if (i != count) return error.UnsupportedScene;
    return ratios;
}

fn splitStart(total: usize, ratios: []const usize, idx: usize) usize {
    var prefix: usize = 0;
    for (0..idx) |i| prefix += ratios[i];
    var sum: usize = 0;
    for (ratios) |r| sum += r;
    return (total * prefix) / sum;
}

fn splitSize(total: usize, ratios: []const usize, idx: usize) usize {
    var sum: usize = 0;
    for (ratios) |r| sum += r;
    const start = splitStart(total, ratios, idx);
    const end = splitStart(total, ratios, idx + 1);
    _ = sum;
    return end - start;
}

fn parseHexColor(input: []const u8) !Color {
    if (input.len != 7 or input[0] != '#') return error.InvalidColor;
    const r = try std.fmt.parseInt(u8, input[1..3], 16);
    const g = try std.fmt.parseInt(u8, input[3..5], 16);
    const b = try std.fmt.parseInt(u8, input[5..7], 16);
    return .{ .r = r, .g = g, .b = b };
}

fn writeImageAsPng(writer: anytype, allocator: std.mem.Allocator, pixels: []const u8) !void {
    var raw = std.ArrayList(u8).init(allocator);
    defer raw.deinit();

    try raw.ensureTotalCapacity((image_width * 4 + 1) * image_height);

    for (0..image_height) |y| {
        try raw.append(0); // filter: none

        const start = y * image_width * 4;
        const end = start + image_width * 4;
        try raw.appendSlice(pixels[start..end]);
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

test "scene graph render supports full-screen color scene" {
    const scene =
        \\{
        \\  "settings": {"backgroundColor": "#000000"},
        \\  "nodes": [
        \\    {"id": "root", "data": {"keyword": "render"}},
        \\    {"id": "color", "data": {"keyword": "render/color", "config": {"color": "#525dff"}}}
        \\  ],
        \\  "edges": [
        \\    {"source": "root", "sourceHandle": "next", "target": "color", "targetHandle": "prev"}
        \\  ]
        \\}
    ;

    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, scene, .{});
    defer parsed.deinit();
    const graph = try parseSceneGraph(std.testing.allocator, parsed.value, "renderColorFlow");
    defer graph.deinit(std.testing.allocator);
    var image = try Image.init(std.testing.allocator, graph.background);
    defer image.deinit(std.testing.allocator);
    const root = graph.findRootRender().?;
    const next = graph.edgeFrom(root.id, "next").?;
    try renderNode(&image, graph, next.target, .{ .x = 0, .y = 0, .w = image_width, .h = image_height });

    try std.testing.expectEqual(@as(u8, 0x52), image.pixels[0]);
    try std.testing.expectEqual(@as(u8, 0x5d), image.pixels[1]);
    try std.testing.expectEqual(@as(u8, 0xff), image.pixels[2]);
}

test "render rejects incomplete split config" {
    const scene =
        \\{
        \\  "nodes": [
        \\    {"id": "root", "data": {"keyword": "render"}},
        \\    {"id": "split", "data": {"keyword": "render/split", "config": {"rows": "2", "columns": "2"}}}
        \\  ],
        \\  "edges": [
        \\    {"source": "root", "sourceHandle": "next", "target": "split", "targetHandle": "prev"}
        \\  ]
        \\}
    ;

    var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, scene, .{});
    defer parsed.deinit();
    const graph = try parseSceneGraph(std.testing.allocator, parsed.value, "renderSplitFlow");
    defer graph.deinit(std.testing.allocator);
    var image = try Image.init(std.testing.allocator, graph.background);
    defer image.deinit(std.testing.allocator);
    try std.testing.expectError(error.UnsupportedScene, renderNode(&image, graph, "split", .{ .x = 0, .y = 0, .w = image_width, .h = image_height }));
}

test "split ratios compute expected geometry" {
    const ratios = [_]usize{ 3, 1, 3 };
    try std.testing.expectEqual(@as(usize, 0), splitStart(300, &ratios, 0));
    try std.testing.expectEqual(@as(usize, 128), splitStart(300, &ratios, 1));
    try std.testing.expectEqual(@as(usize, 171), splitStart(300, &ratios, 2));
    try std.testing.expectEqual(@as(usize, 128), splitSize(300, &ratios, 0));
}
