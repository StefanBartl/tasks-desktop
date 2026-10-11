//! `tasks-hub serve | open | --version`

use tasks_hub::app::{self, ServeOptions};

const USAGE: &str = "usage:
  tasks-hub serve [--port <1024-65535>]   run the hub until Ctrl-C
  tasks-hub open                          print a one-time pairing link for the running hub
  tasks-hub --version";

fn parse_port(args: &[String]) -> Result<Option<u16>, String> {
    match args {
        [] => Ok(None),
        [flag, value] if flag == "--port" => value
            .parse::<u16>()
            .ok()
            .filter(|p| *p >= 1024)
            .map(Some)
            .ok_or_else(|| format!("--port must be a number from 1024 to 65535, not {value:?}")),
        _ => Err(USAGE.to_owned()),
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("serve") => match parse_port(&args[1..]) {
            Ok(port) => app::serve(ServeOptions { port }).await,
            Err(e) => Err(e),
        },
        Some("open") if args.len() == 1 => app::open().await.map(|url| println!("{url}")),
        Some("--version" | "-V") => {
            println!("tasks-hub {}", tasks_hub::VERSION);
            Ok(())
        }
        _ => Err(USAGE.to_owned()),
    };
    if let Err(message) = result {
        eprintln!("tasks-hub: {message}");
        std::process::exit(1);
    }
}
