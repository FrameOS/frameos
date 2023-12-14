from copy import deepcopy

from apps import App, ExecutionContext


class SplitApp(App):
    def __post_init__(self):
        pass

    def run(self, context: ExecutionContext):
        rows = int(self.get_config('rows', '1'))
        columns = int(self.get_config('columns', '1'))

        margin = self.get_config('margin', '0').split(' ')
        margin_top = int(margin[0]) if len(margin[0]) > 0 else 0
        margin_right = int(margin[1]) if len(margin) > 1 else margin_top
        margin_bottom = int(margin[2]) if len(margin) > 2 else margin_top
        margin_left = int(margin[3]) if len(margin) > 3 else margin_right

        gap = self.get_config('gap', '0').split(' ')
        gap_horizontal = int(gap[0]) if len(gap[0]) > 0 else 0
        gap_vertical = int(gap[1]) if len(gap) > 1 else gap_horizontal

        context_width, context_height = context.image.size
        image_width = context_width - margin_left - margin_right - (gap_horizontal * (columns - 1))
        image_height = context_height - margin_top - margin_bottom - (gap_vertical * (rows - 1))

        width_ratio_input = self.get_config('width_ratios', '1').split(' ')
        height_ratio_input = self.get_config('height_ratios', '1').split(' ')

        width_ratios = []
        for i in range(columns):
            try:
                width_ratios.append(int(width_ratio_input[i % len(width_ratio_input)] or '1'))
            except ValueError:
                width_ratios.append(1)
        height_ratios = []
        for i in range(rows):
            try:
                height_ratios.append(int(height_ratio_input[i % len(height_ratio_input)] or '1'))
            except ValueError:
                height_ratios.append(1)

        width_ratio_sum = sum(width_ratios)
        height_ratio_sum = sum(height_ratios)

        cell_widths = [int(image_width * (float(ratio) / width_ratio_sum)) for ratio in width_ratios]
        cell_heights = [int(image_height * (float(ratio) / height_ratio_sum)) for ratio in height_ratios]

        cell_widths[-1] = image_width - sum(cell_widths[:-1])
        cell_heights[-1] = image_height - sum(cell_heights[:-1])

        edges = self.app_handler.current_scene_handler().node_edges.get(self.node.id, {})
        render_edge = edges.get('field/render_function', None)
        node_id = render_edge.target if render_edge is not None else None

        try:
            if node_id is None:
                raise Exception("No render function specified")

            self.log(f"Rendering {rows}x{columns} grid")

            for row in range(rows):
                for column in range(columns):
                    self.log(f"Rendering row {row + 1}, column {column + 1}")

                    width = cell_widths[column]
                    height = cell_heights[row]
                    top = sum(cell_heights[0:row]) + margin_top + (gap_vertical * row)
                    left = sum(cell_widths[0:column]) + margin_left + (gap_horizontal * column)

                    new_image = context.image.crop((left, top, left + width, top + height))
                    new_context = ExecutionContext(
                        parent=context,
                        event=context.event,
                        payload=deepcopy(context.payload),
                        image=new_image,
                        state={**deepcopy(context.state), 'row': row + 1, 'column': column + 1},
                        apps_ran=context.apps_ran,
                        apps_errored=context.apps_errored
                    )
                    new_context = self.app_handler.run_node(node_id, new_context)
                    context.image.paste(new_context.image, (left, top))
        except Exception as e:
            self.error(f"Error rendering split image. Error: {e}")
            raise e