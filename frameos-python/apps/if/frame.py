from apps import App, ExecutionContext


class IfApp(App):
    def run(self, context: ExecutionContext):
        edges = self.app_handler.current_scene_handler().node_edges.get(self.node.id, {})
        condition = self.get_config('condition', 'True')
        then_edge = edges.get('field/then', None)
        then_id = then_edge.target if then_edge is not None else None
        else_edge = edges.get('field/else', None)
        else_id = else_edge.target if else_edge is not None else None

        try:
            response = eval(condition, context.state)
        except Exception as e:
            self.error(f"Error evaluating condition {condition}. Error: {e}")
            raise e

        if response:
            if then_id is None:
                raise Exception("No then function specified")
            try:
                self.app_handler.run_node(then_id, context)
            except Exception as e:
                self.error(f"Error rendering then function. Error: {e}")
                raise e
        else:
            if else_id is None:
                raise Exception("No else function specified")
            try:
                self.app_handler.run_node(else_id, context)
            except Exception as e:
                self.error(f"Error rendering else function. Error: {e}")
                raise e
