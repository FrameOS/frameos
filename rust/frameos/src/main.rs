use std::env;

use frameos::config::FrameOSConfig;
use frameos::runtime::Runtime;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() > 1 && args[1] == "check" {
        println!("FrameOS check: passed 🎉");
        return Ok(());
    }

    let config = FrameOSConfig::default();
    let runtime = Runtime::new(config);
    runtime.start()?;
    Ok(())
}
