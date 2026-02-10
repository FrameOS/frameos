use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashMap};

use crate::apps::{execute_ported_app, AppExecutionContext, AppExecutionError, AppOutput};
use crate::models::SceneDescriptor;

/// In-memory scene catalog placeholder.
#[derive(Debug, Default)]
pub struct SceneCatalog {
    scenes: Vec<SceneDescriptor>,
}

impl SceneCatalog {
    pub fn with_scenes(scenes: Vec<SceneDescriptor>) -> Self {
        Self { scenes }
    }

    pub fn scenes(&self) -> &[SceneDescriptor] {
        &self.scenes
    }
}

/// A single executable node within a scene graph.
#[derive(Debug, Clone, PartialEq)]
pub struct SceneNode {
    pub id: u64,
    pub keyword: String,
    pub fields: Map<String, Value>,
    pub next_node: Option<u64>,
}

/// Deterministic app execution graph for a scene.
#[derive(Debug, Clone, PartialEq)]
pub struct SceneGraph {
    pub id: String,
    pub entry_node: u64,
    pub nodes: Vec<SceneNode>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SceneRunReport {
    pub scene_id: String,
    pub visited_nodes: Vec<u64>,
    pub outputs: Vec<AppOutput>,
    pub context: AppExecutionContext,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SceneRunError {
    EmptyNodes,
    MissingEntryNode(u64),
    DuplicateNodeId(u64),
    MissingNode(u64),
    LoopDetected {
        node_id: u64,
    },
    App {
        node_id: u64,
        source: AppExecutionError,
    },
}

impl std::fmt::Display for SceneRunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyNodes => write!(f, "scene graph has no nodes"),
            Self::MissingEntryNode(node_id) => {
                write!(f, "scene graph entry node {node_id} does not exist")
            }
            Self::DuplicateNodeId(node_id) => write!(f, "duplicate scene node id: {node_id}"),
            Self::MissingNode(node_id) => write!(f, "scene node {node_id} does not exist"),
            Self::LoopDetected { node_id } => {
                write!(f, "scene graph loop detected at node {node_id}")
            }
            Self::App { node_id, source } => {
                write!(f, "scene node {node_id} failed to execute: {source}")
            }
        }
    }
}

impl std::error::Error for SceneRunError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::App { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl SceneGraph {
    pub fn run(&self, context: AppExecutionContext) -> Result<SceneRunReport, SceneRunError> {
        if self.nodes.is_empty() {
            return Err(SceneRunError::EmptyNodes);
        }

        let mut node_by_id = HashMap::new();
        for node in &self.nodes {
            if node_by_id.insert(node.id, node).is_some() {
                return Err(SceneRunError::DuplicateNodeId(node.id));
            }
        }

        if !node_by_id.contains_key(&self.entry_node) {
            return Err(SceneRunError::MissingEntryNode(self.entry_node));
        }

        let mut current_node_id = self.entry_node;
        let mut visited = BTreeSet::new();
        let mut visited_nodes = Vec::new();
        let mut outputs = Vec::new();
        let mut context = context;

        loop {
            if !visited.insert(current_node_id) {
                return Err(SceneRunError::LoopDetected {
                    node_id: current_node_id,
                });
            }

            let node = node_by_id
                .get(&current_node_id)
                .ok_or(SceneRunError::MissingNode(current_node_id))?;

            visited_nodes.push(current_node_id);

            let output = execute_ported_app(&node.keyword, &node.fields, &mut context).map_err(
                |source| SceneRunError::App {
                    node_id: current_node_id,
                    source,
                },
            )?;

            let next_node = match output {
                AppOutput::BranchNode(node_id) if node_id != 0 => Some(node_id),
                _ => node.next_node,
            };

            outputs.push(output);

            let Some(next_node_id) = next_node else {
                break;
            };
            current_node_id = next_node_id;
        }

        Ok(SceneRunReport {
            scene_id: self.id.clone(),
            visited_nodes,
            outputs,
            context,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scene_graph_runs_linear_chain_and_mutates_state() {
        let mut set_state_fields = Map::new();
        set_state_fields.insert("stateKey".to_string(), serde_json::json!("payload"));
        set_state_fields.insert("valueString".to_string(), serde_json::json!("ok"));

        let mut sleep_fields = Map::new();
        sleep_fields.insert("duration".to_string(), serde_json::json!(2.5));

        let graph = SceneGraph {
            id: "demo/linear".to_string(),
            entry_node: 1,
            nodes: vec![
                SceneNode {
                    id: 1,
                    keyword: "logic/setAsState".to_string(),
                    fields: set_state_fields,
                    next_node: Some(2),
                },
                SceneNode {
                    id: 2,
                    keyword: "logic/nextSleepDuration".to_string(),
                    fields: sleep_fields,
                    next_node: None,
                },
            ],
        };

        let report = graph
            .run(AppExecutionContext::default())
            .expect("scene graph should execute");

        assert_eq!(report.visited_nodes, vec![1, 2]);
        assert_eq!(report.outputs, vec![AppOutput::Empty, AppOutput::Empty]);
        assert_eq!(
            report.context.state.get("payload"),
            Some(&serde_json::json!("ok"))
        );
        assert_eq!(report.context.next_sleep_seconds, Some(2.5));
    }

    #[test]
    fn scene_graph_uses_branch_output_as_next_node() {
        let mut branch_fields = Map::new();
        branch_fields.insert("condition".to_string(), serde_json::json!(true));
        branch_fields.insert("thenNode".to_string(), serde_json::json!(3));
        branch_fields.insert("elseNode".to_string(), serde_json::json!(2));

        let mut parse_fields = Map::new();
        parse_fields.insert(
            "text".to_string(),
            serde_json::json!("{\"selected\": true}"),
        );

        let graph = SceneGraph {
            id: "demo/branch".to_string(),
            entry_node: 1,
            nodes: vec![
                SceneNode {
                    id: 1,
                    keyword: "logic/ifElse".to_string(),
                    fields: branch_fields,
                    next_node: Some(2),
                },
                SceneNode {
                    id: 2,
                    keyword: "logic/breakIfRendering".to_string(),
                    fields: Map::new(),
                    next_node: None,
                },
                SceneNode {
                    id: 3,
                    keyword: "data/parseJson".to_string(),
                    fields: parse_fields,
                    next_node: None,
                },
            ],
        };

        let report = graph
            .run(AppExecutionContext::default())
            .expect("scene graph should execute");

        assert_eq!(report.visited_nodes, vec![1, 3]);
        assert_eq!(
            report.outputs,
            vec![
                AppOutput::BranchNode(3),
                AppOutput::Value(serde_json::json!({"selected": true})),
            ]
        );
    }

    #[test]
    fn scene_graph_rejects_cycles() {
        let graph = SceneGraph {
            id: "demo/cycle".to_string(),
            entry_node: 1,
            nodes: vec![SceneNode {
                id: 1,
                keyword: "logic/breakIfRendering".to_string(),
                fields: Map::new(),
                next_node: Some(1),
            }],
        };

        let error = graph
            .run(AppExecutionContext::default())
            .expect_err("cycle should be rejected");
        assert_eq!(error, SceneRunError::LoopDetected { node_id: 1 });
    }
}
