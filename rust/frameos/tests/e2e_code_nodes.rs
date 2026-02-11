use frameos::e2e::{E2eRenderer, E2eScene};
use image::GenericImageView;
use serde_json::json;

#[test]
fn split_loop_index_can_drive_render_color_via_code_node() {
    let tmp = tempfile::tempdir().expect("temp dir");
    let scene_path = tmp.path().join("split-loop.json");
    let scene = json!({
      "name": "split loop color",
      "settings": {"backgroundColor": "#000000"},
      "nodes": [
        {"id":"event","type":"event","data":{"keyword":"render"}},
        {"id":"split","type":"app","data":{"keyword":"render/split","config":{"rows":"16","columns":"16","hideEmpty":"true"}}},
        {"id":"color","type":"app","data":{"keyword":"render/color","config":{}}},
        {"id":"code","type":"code","data":{
          "code":"hsl(context.loopIndex.float / 256 * 360, 50, 50).color()",
          "codeJS":"(()=>{let h=context.loopIndex/256*360,s=.5,l=.5,f=n=>{let k=(n+h/30)%12,a=s*Math.min(l,1-l);return l-a*Math.max(-1,Math.min(k-3,9-k,1))},x=n=>Math.round(n*255).toString(16).padStart(2,'0');return'#'+x(f(0))+x(f(8))+x(f(4));})()"
        }}
      ],
      "edges": [
        {"source":"event","sourceHandle":"next","target":"split","targetHandle":"prev"},
        {"source":"split","sourceHandle":"field/render_function","target":"color","targetHandle":"prev"},
        {"source":"code","sourceHandle":"fieldOutput","target":"color","targetHandle":"fieldInput/color"}
      ]
    });
    std::fs::write(
        &scene_path,
        serde_json::to_vec_pretty(&scene).expect("serialize"),
    )
    .expect("write scene");

    let parsed = E2eScene::from_path(&scene_path).expect("parse scene");
    let renderer = E2eRenderer {
        width: 320,
        height: 480,
        assets_dir: tmp.path().to_path_buf(),
    };
    let rendered = renderer.render_scene(&parsed).expect("render");

    let cell_w = 320 / 16;
    let cell_h = 480 / 16;
    let first = rendered.get_pixel(cell_w / 2, cell_h / 2).0;
    let last = rendered.get_pixel(320 - cell_w / 2, 480 - cell_h / 2).0;

    assert_ne!(
        first, last,
        "loop-index shader should vary color across cells"
    );
    assert_eq!(first[0], 191, "expected hsl(0,50,50) red channel");
    assert_eq!(first[1], 64, "expected hsl(0,50,50) green channel");
    assert_eq!(first[2], 64, "expected hsl(0,50,50) blue channel");
}
