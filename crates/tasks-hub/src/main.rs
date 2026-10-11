//! `tasks-hub serve | open | --version`

use tasks_hub::app::{self, AreasCommand, ServeOptions};

const USAGE: &str = "usage:
  tasks-hub serve [--port <1024-65535>]   run the hub until Ctrl-C
  tasks-hub open                          print a one-time pairing link for the running hub
  tasks-hub areas propose [--private=a,b] [--write]
                                          propose a data class for every area (written, with
                                          --write, as areas.proposed.json: nothing is released
                                          until you rename it to areas.json)
  tasks-hub areas check                   list the areas that have no data class (exit 1 if any)
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

fn parse_areas(args: &[String]) -> Result<AreasCommand, String> {
    match args.split_first() {
        Some((verb, rest)) if verb == "propose" => {
            let mut private = Vec::new();
            let mut write = false;
            for arg in rest {
                if arg == "--write" {
                    write = true;
                } else if let Some(list) = arg.strip_prefix("--private=") {
                    private.extend(list.split(',').filter(|s| !s.is_empty()).map(str::to_owned));
                } else {
                    return Err(USAGE.to_owned());
                }
            }
            Ok(AreasCommand::Propose { private, write })
        }
        Some((verb, rest)) if verb == "check" && rest.is_empty() => Ok(AreasCommand::Check),
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
        Some("areas") => match parse_areas(&args[1..]) {
            Ok(command) => app::areas(command).await.map(|text| print!("{text}")),
            Err(e) => Err(e),
        },
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
