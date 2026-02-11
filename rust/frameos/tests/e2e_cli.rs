use std::path::Path;

use frameos::e2e_cli::{default_e2e_options, run_e2e_snapshot_parity};

#[test]
fn e2e_parity_runner_passes_against_repo_snapshots() {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut opts = default_e2e_options(&repo_root);
    opts.output_dir = repo_root.join("e2e/rust-output-test");

    let report = run_e2e_snapshot_parity(&opts).expect("e2e parity should execute");
    assert!(report.passed(), "e2e parity failures: {:?}", report.failed);
    assert!(report.checked > 0, "expected at least one e2e scene");
}
