//! `tasks-hub serve | open | --version`

use tasks_hub::app::{self, AreasCommand, ServeOptions};
use tasks_hub::background::{self, Autostart};

const USAGE: &str = "usage:
  tasks-hub serve [--port <1024-65535>]   run the hub until Ctrl-C
  tasks-hub start [--open]                run the hub in the background (no window; log in
                                          the config folder); --open also opens the browser
  tasks-hub stop                          stop the hub that runs in the background
  tasks-hub autostart on|off|status       start the hub with your login (Windows)
  tasks-hub open [--launch]               print a one-time pairing link for the running hub
                                          (--launch also opens it in the default browser)
  tasks-hub usage [--days=14]             on how many of the last days the interface was
                                          opened (counts only, kept on this machine)
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

fn parse_days(args: &[String]) -> Result<u32, String> {
    match args {
        [] => Ok(14),
        [flag] => flag
            .strip_prefix("--days=")
            .and_then(|n| n.parse::<u32>().ok())
            .filter(|n| (1..=366).contains(n))
            .ok_or_else(|| "--days is a number from 1 to 366".to_owned()),
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
        Some("start") if args.len() == 1 || (args.len() == 2 && args[1] == "--open") => {
            match background::start().await {
                Ok(text) => {
                    print!("{text}");
                    if args.len() == 2 {
                        match app::open().await {
                            Ok(url) => app::launch(&url),
                            Err(e) => Err(e),
                        }
                    } else {
                        Ok(())
                    }
                }
                Err(e) => Err(e),
            }
        }
        Some("stop") if args.len() == 1 => background::stop().await.map(|t| print!("{t}")),
        Some("autostart") if args.len() == 2 => match args[1].as_str() {
            "on" => Ok(Autostart::On),
            "off" => Ok(Autostart::Off),
            "status" => Ok(Autostart::Status),
            _ => Err(USAGE.to_owned()),
        }
        .and_then(background::autostart)
        .map(|t| print!("{t}")),
        Some("open") if args.len() == 1 => app::open().await.map(|url| println!("{url}")),
        Some("open") if args.len() == 2 && args[1] == "--launch" => match app::open().await {
            Ok(url) => {
                println!("{url}");
                app::launch(&url)
            }
            Err(e) => Err(e),
        },
        Some("usage") => match parse_days(&args[1..]) {
            Ok(days) => app::usage(days).map(|text| print!("{text}")),
            Err(e) => Err(e),
        },
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
