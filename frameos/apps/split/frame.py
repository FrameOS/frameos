from apps import App, ExecutionContext


class SplitApp(App):
    def __post_init__(self):
        pass

    def run(self, context: ExecutionContext):
        image_width, image_height = context.image.size
        rows = int(self.get_config('rows', '1'))
        columns = int(self.get_config('columns', '1'))

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

                    width = int(image_width / columns)
                    height = int(image_height / rows)
                    top = height * row
                    left = width * column
                    if row == rows - 1:
                        height = image_height - (height * (rows - 1))
                    if column == columns - 1:
                        width = image_width - (width * (columns - 1))

                    new_image = context.image.crop((left, top, left + width, top + height))
                    new_context = ExecutionContext(
                        event=context.event,
                        payload={**context.payload.copy(), 'row': row + 1, 'column': column + 1},
                        image=new_image,
                        state=context.state,
                        apps_ran=context.apps_ran,
                        apps_errored=context.apps_errored
                    )
                    new_context = self.app_handler.run_node(node_id, new_context)
                    context.image.paste(new_context.image, (left, top))
        except Exception as e:
            self.error(f"Error rendering split image. Error: {e}")
            raise e
