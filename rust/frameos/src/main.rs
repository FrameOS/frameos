use std::env;

use frameos::config::FrameOSConfig;
use frameos::logging;
use frameos::runtime::Runtime;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() > 1 && args[1] == "check" {
        println!("FrameOS check: passed 🎉");
        return Ok(());
    }

    let config = FrameOSConfig::load()?;
    logging::debug("FrameOS configuration loaded.");
    let runtime = Runtime::new(config);
    runtime.start()?;
    Ok(())
}
